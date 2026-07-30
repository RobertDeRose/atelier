import { createInterface } from "node:readline/promises";
import {
  AtelierCore,
  ensurePlanDocument,
  taskConstraintSummary,
  parsePlanFile,
  resolveEditorCommand,
  runInteractiveProcess,
  type CodeProviderStatus,
  type CodeSearchHit,
  type CodeWorkspace,
  type ExecutionPreparation,
  type ManualEdit,
  type PlanDiagnostic,
  type RetrievalSessionStatus,
  type TaskReconciliation,
} from "../../../packages/core/src/index.ts";
import { flagBoolean, flagString, type ParsedArgs } from "./arguments.ts";

export function asJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function retrievalText(retrieval: RetrievalSessionStatus): string {
  return [
    `Retrieval session: ${retrieval.sessionId}`,
    `Decision: ${retrieval.lastDecision?.kind ?? "none"}${retrieval.lastDecision === undefined ? "" : ` — ${retrieval.lastDecision.reason}`}`,
    `Inventory: ${retrieval.inventory.evidenceCount} entries, ${retrieval.inventory.uniquePathCount} unique paths, freshness ${retrieval.inventory.freshness}`,
    `Known paths: ${retrieval.inventory.knownPaths.join(", ") || "none"}`,
    `Resolved symbols: ${retrieval.inventory.resolvedSymbols.join(", ") || "none"}; unresolved: ${retrieval.inventory.unresolvedSymbols.join(", ") || "none"}`,
    `Remaining provider requests: ${Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed)}`,
    `Deduplication: ${retrieval.telemetry.duplicateResultsRemoved} results and ${retrieval.telemetry.duplicatePathsRemoved} paths removed`,
    `Bytes returned: ${retrieval.telemetry.bytesReturned}; truncated: ${retrieval.telemetry.truncated}`,
  ].join("\n");
}

function codeJsonPayload(
  results: CodeSearchHit[],
  status: CodeProviderStatus,
  workspace: CodeWorkspace,
  retrieval: RetrievalSessionStatus,
) {
  return {
    results,
    decision: retrieval.lastDecision ?? null,
    telemetry: retrieval.telemetry,
    inventory: retrieval.inventory,
    budget: retrieval.budget,
    diagnostics: retrieval.diagnostics,
    invalidations: retrieval.invalidations,
    truncation: { truncated: retrieval.telemetry.truncated },
    provenance: results.map((result) => result.provenance),
    scope: {
      workspaceId: workspace.id,
      repositoryIds: workspace.repositories.map((repository) => repository.id),
      provider: status.identity,
      indexState: status.indexState,
    },
    retrieval,
  };
}

export async function handleCode(core: AtelierCore, subcommand: string | undefined, rest: string[], parsed: ParsedArgs): Promise<void> {
  const provider = flagString(parsed, "provider");
  if (subcommand === "providers") {
    const statuses = await core.code.providers(core.codeWorkspace());
    if (flagBoolean(parsed, "json")) asJson(statuses);
    else for (const status of statuses) process.stdout.write(`${status.identity.name}\t${status.available ? "available" : "unavailable"}\t${status.indexState}\t${status.capabilities.join(",")}\n`);
    return;
  }
  if (subcommand === "status" || subcommand === "doctor") {
    const workspace = core.codeWorkspace();
    const status = await core.code.status(provider, workspace);
    const retrieval = core.code.retrievalStatus();
    if (flagBoolean(parsed, "json") || subcommand === "doctor") asJson({ workspace, status, retrieval });
    else process.stdout.write([
      `Provider: ${status.identity.name}`,
      `Available: ${status.available}`,
      `Healthy: ${status.healthy}`,
      `Index: ${status.indexState}`,
      `Capabilities: ${status.capabilities.join(", ") || "none"}`,
      ...(status.degraded === true ? ["Degraded: true"] : []),
      ...(status.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
      ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
      "",
      retrievalText(retrieval),
    ].join("\n") + "\n");
    return;
  }
  if (subcommand === "index") {
    const state = await core.code.ensureIndex(core.codeWorkspace(), provider);
    if (flagBoolean(parsed, "json")) asJson({ provider: provider ?? core.config.codeProvider, state });
    else process.stdout.write(`Code index state: ${state}\n`);
    return;
  }
  if (subcommand === "related") {
    const opaqueId = rest.join(" ").trim();
    if (!opaqueId) throw new Error("Usage: atlr code related REFERENCE [--repo ID] [--kind imports,calls,dependencies,references] [--depth N] [--limit N]");
    const workspace = core.codeWorkspace();
    const repositoryId = flagString(parsed, "repo") ?? workspace.repositories[0]?.id;
    if (!repositoryId) throw new Error("No repository is configured");
    const kinds = (flagString(parsed, "kind") ?? "references").split(",").filter(Boolean) as Array<"imports"|"calls"|"dependencies"|"references">;
    const relationships = await core.code.relationships({ workspace, reference: { provider: provider ?? core.config.codeProvider, opaqueId, repositoryId, path: flagString(parsed, "path") ?? opaqueId }, kinds, depth: Number(flagString(parsed, "depth") ?? "1"), limit: Number(flagString(parsed, "limit") ?? "20") }, provider);
    if (flagBoolean(parsed, "json")) asJson(relationships); else for (const item of relationships) process.stdout.write(`${item.kind}\t${item.target.repositoryId}:${item.target.path}\n`);
    return;
  }
  if (subcommand === "search" || subcommand === "symbols") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error(`Usage: atlr code ${subcommand} QUERY [--provider NAME] [--repo ID] [--limit N] [--mode auto|semantic|hybrid|lexical] [--focus auto|source|tests|docs|all] [--hint IDENTIFIER,...]`);
    const repositoryIds = flagString(parsed, "repo")?.split(",").map((value) => value.trim()).filter(Boolean);
    const limit = Number(flagString(parsed, "limit") ?? "10");
    const mode = flagString(parsed, "mode") ?? (subcommand === "search" ? "semantic" : "auto");
    if (!(["auto", "semantic", "hybrid", "lexical"] as const).includes(mode as "auto" | "semantic" | "hybrid" | "lexical")) throw new Error(`Invalid code search mode: ${mode}`);
    const focus = flagString(parsed, "focus") ?? "auto";
    if (!(["auto", "source", "tests", "docs", "all"] as const).includes(focus as "auto" | "source" | "tests" | "docs" | "all")) throw new Error(`Invalid code search focus: ${focus}`);
    const literalHints = flagString(parsed, "hint")?.split(",").map((value) => value.trim()).filter(Boolean);
    const workspace = core.codeWorkspace();
    const results = subcommand === "search"
      ? await core.code.search({ workspace, text: query, mode: mode as "auto" | "semantic" | "hybrid" | "lexical", focus: focus as "auto" | "source" | "tests" | "docs" | "all", ...(literalHints === undefined ? {} : { literalHints }), ...(provider === undefined ? {} : { provider }), ...(repositoryIds === undefined ? {} : { repositoryIds }), limit: Number.isFinite(limit) ? limit : 10 })
      : await core.code.symbols({ workspace, text: query, ...(provider === undefined ? {} : { provider }), ...(repositoryIds === undefined ? {} : { repositoryIds }), limit: Number.isFinite(limit) ? limit : 10, requireUnresolved: false });
    const status = await core.code.status(provider, workspace);
    const retrieval = core.code.retrievalStatus();
    if (flagBoolean(parsed, "json")) asJson(codeJsonPayload(results, status, workspace, retrieval));
    else {
      for (const hit of results) process.stdout.write(`${hit.repositoryName}:${hit.path}${hit.startLine === undefined ? "" : `:${hit.startLine}`}\t${hit.symbol ?? ""}\t${hit.preview ?? ""}\t[${hit.provenance.provider.name}/${hit.provenance.indexState}]\n`);
      if (results.length > 0) process.stdout.write("Use built-in read for returned paths; do not search again to inspect known files.\n");
      if (retrieval.lastDecision?.kind === "no_provider_call") process.stdout.write(`No provider call: ${retrieval.lastDecision.reason}\n`);
      process.stdout.write(`${retrievalText(retrieval)}\n`);
    }
    return;
  }
  throw new Error("Usage: atlr code <providers|status|index|search|symbols|related|doctor>");
}

export async function handlePlan(core: AtelierCore, subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case "create": {
      const created = ensurePlanDocument(core.config.planPath);
      process.stdout.write(`${created ? "Created" : "Existing"} plan: ${core.config.planPath}\n`);
      return;
    }
    case "parse": {
      ensurePlanDocument(core.config.planPath);
      const plan = parsePlanFile(core.config.planPath);
      if (flagBoolean(args, "json")) asJson(plan);
      else {
        process.stdout.write(`${plan.title}\nHash: ${plan.hash}\nTasks: ${plan.tasks.length}\n`);
        for (const diagnostic of plan.diagnostics) {
          process.stdout.write(`${diagnostic.level.toUpperCase()} ${diagnostic.code}${diagnostic.line ? `:${diagnostic.line}` : ""}: ${diagnostic.message}\n`);
        }
      }
      if (plan.diagnostics.some((diagnostic) => diagnostic.level === "error")) process.exitCode = 2;
      return;
    }
    case "review": {
      ensurePlanDocument(core.config.planPath);
      const editor = resolveEditorCommand(core.config, true);
      const started = core.beginPlanReview({ editor });
      const result = await runInteractiveProcess({
        command: editor.executable,
        args: [...editor.args, core.config.planPath],
        cwd: core.config.repositoryRoot,
      });
      if (result.exitCode !== 0 || result.signal !== undefined || result.error !== undefined) {
        core.cancelPlanReview(started.id, {
          status: result.signal === undefined ? "failed" : "interrupted",
          exitCode: result.exitCode,
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        throw new Error(`Editor exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`);
      }
      const manualEdit = core.completePlanReview(started.id, { exitCode: result.exitCode });
      const plan = core.parsePlan();
      let reconciliation: Awaited<ReturnType<AtelierCore["reconcilePlan"]>> | undefined;
      let reconciliationError: string | undefined;
      try {
        reconciliation = await core.reconcilePlan(false);
      } catch (error) {
        reconciliationError = error instanceof Error ? error.message : String(error);
      }
      const payload = {
        manualEdit,
        diagnostics: plan.diagnostics,
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ...(reconciliationError === undefined ? {} : { reconciliationError }),
      };
      if (flagBoolean(args, "json")) asJson(payload);
      else process.stdout.write(reviewText(payload));
      return;
    }
    case "prepare": {
      const prepared = await core.execution.prepare();
      if (flagBoolean(args, "json")) asJson(prepared);
      else process.stdout.write(`${preparationText(core, prepared)}\n`);
      return;
    }
    case "approve": {
      const approvalId = flagString(args, "approval");
      if (approvalId === undefined) {
        const prepared = await core.execution.prepare();
        if (flagBoolean(args, "json")) asJson(prepared);
        else process.stdout.write(`${preparationText(core, prepared)}\nApply with: atlr approve --approval ${prepared.approval.id} --digest ${prepared.approval.reconciliationDigest} --yes\n`);
        return;
      }
      const approval = core.ledger.getPlanApproval(approvalId);
      if (approval === undefined || approval.status !== "prepared") throw new Error(`Prepared approval not found or no longer pending: ${approvalId}`);
      const digest = flagString(args, "digest");
      if (digest === undefined || digest !== approval.reconciliationDigest) {
        throw new Error(`Approval digest mismatch. Expected --digest ${approval.reconciliationDigest}.`);
      }
      const transaction = core.ledger.getApprovalReconciliationTransaction(approval.id);
      if (transaction === undefined) throw new Error(`Prepared reconciliation is missing for ${approval.id}.`);
      const currentPlan = core.parsePlan();
      if (currentPlan.hash !== approval.planHash) {
        throw new Error("Plan changed after preparation. Prepare and inspect a fresh exact transaction.");
      }
      const prepared = { approval, transaction, reconciliation: transaction.preview };
      if (!flagBoolean(args, "json")) process.stdout.write(`${preparationText(core, prepared)}\n`);
      const confirmed = await explicitConfirmation(args, "Apply this exact transaction?");
      if (!confirmed) {
        await core.execution.approveAndApply(approvalId, false);
        process.stdout.write("Approval rejected. No provider mutation was applied.\n");
        return;
      }
      const transition = await core.execution.approveAndApply(approvalId, true);
      if (flagBoolean(args, "json")) asJson(transition);
      else process.stdout.write(
        `Approved ${transition.approval.planHash}; activated task ${transition.task?.id ?? "none"} `
        + `with execution grant ${transition.executionGrant?.id ?? "none"}.\n`,
      );
      return;
    }
    case "reconcile": {
      if (flagBoolean(args, "apply")) {
        throw new Error("Use plan prepare, inspect the exact digest, then approve --approval ID.");
      }
      const reconciliation = await core.reconcilePlan(false);
      if (flagBoolean(args, "json")) asJson(reconciliation);
      else {
        process.stdout.write(`Plan: ${reconciliation.planHash}\nApplied: ${reconciliation.applied}\n`);
        for (const operation of reconciliation.operations) process.stdout.write(`- ${operation.kind}: ${operation.planTaskId}\n`);
        for (const conflict of reconciliation.conflicts) process.stdout.write(`CONFLICT: ${conflict}\n`);
      }
      if (reconciliation.conflicts.length > 0) process.exitCode = 3;
      return;
    }
    default:
      throw new Error("Usage: atlr plan [OBJECTIVE] | atlr plan <parse|reconcile>");
  }
}

function reviewText(payload: {
  manualEdit: ManualEdit;
  diagnostics: PlanDiagnostic[];
  reconciliation?: TaskReconciliation;
  reconciliationError?: string;
}): string {
  const diff = payload.manualEdit.structuralDiff;
  return [
    `ManualEdit: ${payload.manualEdit.id} (${payload.manualEdit.accepted ? "accepted" : "blocked"})`,
    `Plan hash: ${payload.manualEdit.afterHash ?? payload.manualEdit.beforeHash}`,
    `Structural diff: added ${diff?.added.join(", ") || "none"}; removed ${diff?.removed.join(", ") || "none"}; changed ${diff?.changed.map((item) => `${item.id}(${item.fields.join(",")})`).join(", ") || "none"}`,
    `Diagnostics: ${payload.diagnostics.length === 0 ? "none" : payload.diagnostics.map((item) => `${item.level}:${item.code} ${item.message}`).join("; ")}`,
    ...(payload.reconciliation === undefined
      ? [`Reconciliation preview unavailable: ${payload.reconciliationError ?? "unknown error"}`]
      : [
          `Reconciliation: ${payload.reconciliation.digest}`,
          `Operations: ${payload.reconciliation.operations.length}`,
          ...payload.reconciliation.operations.map((operation) => `- ${operation.kind}: ${operation.planTaskId}`),
          ...payload.reconciliation.conflicts.map((conflict) => `CONFLICT: ${conflict}`),
        ]),
  ].join("\n") + "\n";
}

function preparationText(core: AtelierCore, prepared: ExecutionPreparation): string {
  const plan = core.parsePlan();
  const retirements = prepared.reconciliation.operations.filter((operation) => operation.kind === "retire");
  const proposed = plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.dependencies.length === 0)
    .sort((left, right) => left.task.priority - right.task.priority || left.index - right.index)[0]?.task;
  return [
    `Approval: ${prepared.approval.id}`,
    `Plan hash: ${prepared.approval.planHash}`,
    `Provider: ${prepared.approval.provider.name}${prepared.approval.provider.version ? ` ${prepared.approval.provider.version}` : ""}`,
    `Reconciliation digest: ${prepared.approval.reconciliationDigest}`,
    `Operations: ${prepared.reconciliation.operations.length}`,
    ...prepared.reconciliation.operations.map((operation) => `- ${operation.kind}: ${operation.planTaskId}`),
    `Retirements: ${retirements.length}${retirements.length === 0 ? "" : ` (${retirements.map((operation) => operation.planTaskId).join(", ")})`}`,
    `Proposed first task: ${proposed === undefined ? "none" : `${proposed.id} — ${proposed.title}`}`,
    ...taskConstraintSummary(prepared.approval.taskConstraints, core.config.repositoryRoot),
  ].join("\n");
}

export async function explicitConfirmation(args: ParsedArgs, prompt: string): Promise<boolean> {
  if (flagBoolean(args, "yes")) return true;
  if (flagBoolean(args, "json")) {
    throw new Error("JSON execution requires the explicit --yes affirmative flag.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Non-interactive execution requires the explicit --yes affirmative flag.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

export async function handleTaskStart(core: AtelierCore, requestedTaskId: string | undefined, args: ParsedArgs): Promise<void> {
  const confirmed = await explicitConfirmation(args, `Activate ${requestedTaskId ?? "the next approved-plan task"}?`);
  if (!confirmed) {
    process.stdout.write("Task activation cancelled.\n");
    return;
  }
  const transition = await core.execution.startNextTask(true, requestedTaskId);
  if (transition === undefined) throw new Error("Task activation was not confirmed.");
  if (flagBoolean(args, "json")) asJson(transition);
  else process.stdout.write(`Activated ${transition.task.id} with execution grant ${transition.executionGrant.id}.\n`);
}

export async function handleTasks(core: AtelierCore, subcommand: string | undefined, rest: string[], args: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case "ready": {
      const tasks = await core.taskProvider.ready();
      if (flagBoolean(args, "json")) asJson(tasks);
      else for (const task of tasks) process.stdout.write(`${task.id}\tP${task.priority}\t${task.status}\t${task.title}\n`);
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("Usage: atlr task show ID");
      const task = await core.taskProvider.get(id);
      if (task === undefined) throw new Error(`Task not found: ${id}`);
      if (flagBoolean(args, "json")) asJson(task);
      else process.stdout.write(`${task.id}: ${task.title}\n${task.description}\n`);
      return;
    }
    case "claim": {
      throw new Error("Direct task claims bypass exact execution authorization. Use: atlr task start [ID] --yes");
    }
    case "start": {
      await handleTaskStart(core, rest[0], args);
      return;
    }
    case "close": {
      const id = rest[0];
      const reason = flagString(args, "reason");
      if (!id || !reason) throw new Error("Usage: atlr task close ID --reason TEXT");
      const currentTaskId = core.ledger.getState<string>("currentTaskId");
      if (currentTaskId !== id) throw new Error(`Task ${id} is not the active execution task.`);
      const result = await core.closeActiveTask(reason);
      asJson(result);
      return;
    }
    default:
      throw new Error("Usage: atlr task <show|start|close>");
  }
}
