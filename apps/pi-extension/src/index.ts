import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  classifyShellCommand,
  ensurePlanDocument,
  hashFile,
  resolveEditorCommand,
  type ActionRequest,
  type ManualEditEditor,
  type Permission,
  type PolicyDecision,
  type RetrievalSessionStatus,
} from "../../../packages/core/src/index.ts";

const STATUS_KEY = "atlr";
const CODE_AGENT_TOOLS = ["atlr_code_search", "atlr_code_symbols", "atlr_code_status"] as const;
const EMPTY_COMPONENT = {
  render: (_width: number): string[] => [],
  invalidate: (): void => {},
};

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

type ToolSchema = Record<string | symbol, unknown>;

function stringSchema(description: string, values?: readonly string[]): ToolSchema {
  return {
    [TYPEBOX_KIND]: "String",
    type: "string",
    description,
    ...(values === undefined ? {} : { enum: [...values] }),
  };
}

function integerSchema(description: string, minimum: number, maximum: number): ToolSchema {
  return {
    [TYPEBOX_KIND]: "Integer",
    type: "integer",
    description,
    minimum,
    maximum,
  };
}

function objectSchema(properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema {
  return {
    [TYPEBOX_KIND]: "Object",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function codeHitText(hit: Awaited<ReturnType<AtelierCore["code"]["search"]>>[number]): string {
  const location = `${hit.repositoryName}:${hit.path}${hit.startLine === undefined ? "" : `:${hit.startLine}`}`;
  const symbol = hit.symbol === undefined ? "" : ` · ${hit.symbol}`;
  const score = hit.providerScore === undefined ? "" : ` · score ${hit.providerScore.toFixed(3)}`;
  const preview = hit.preview?.trim();
  return `${hit.rank}. ${location}${symbol}${score}${preview ? `\n${preview}` : ""}`;
}

function retrievalText(retrieval: RetrievalSessionStatus): string {
  const remainingRequests = Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed);
  const remainingPaths = Math.max(0, retrieval.budget.uniquePathsLimit - retrieval.budget.uniquePathsUsed);
  const inventory = retrieval.inventory.knownPaths.length === 0
    ? "empty"
    : retrieval.inventory.knownPaths.join(", ");
  return [
    `Retrieval session: ${retrieval.sessionId}`,
    `Decision: ${retrieval.lastDecision?.kind ?? "none"}${retrieval.lastDecision === undefined ? "" : ` — ${retrieval.lastDecision.reason}`}`,
    `Inventory: ${retrieval.inventory.evidenceCount} compact entries · ${retrieval.inventory.uniquePathCount} unique paths · freshness ${retrieval.inventory.freshness}`,
    `Known paths: ${inventory}`,
    `Resolved symbols: ${retrieval.inventory.resolvedSymbols.join(", ") || "none"}`,
    `Unresolved symbols: ${retrieval.inventory.unresolvedSymbols.join(", ") || "none"}`,
    `Remaining provider requests: ${remainingRequests}; remaining unique paths: ${remainingPaths}`,
    `Deduplication: ${retrieval.telemetry.duplicateResultsRemoved} results · ${retrieval.telemetry.duplicatePathsRemoved} paths · ${retrieval.telemetry.duplicateReferencesRemoved} references removed`,
    `Bytes returned: ${retrieval.telemetry.bytesReturned}; truncated: ${retrieval.telemetry.truncated}`,
  ].join("\n");
}

function codeToolError(
  error: unknown,
  core: AtelierCore | undefined = activeCore,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const message = errorMessage(error);
  const retrieval = core?.code.retrievalStatus();
  return {
    content: [{
      type: "text",
      text: `Atelier code intelligence failed: ${message}`
        + (retrieval === undefined ? "" : `\n\n${retrievalText(retrieval)}`),
    }],
    details: {
      error: message,
      ...(retrieval === undefined ? {} : { retrieval }),
    },
  };
}

function providerFailureAllowsRawFallback(core: AtelierCore): boolean {
  const retrieval = core.code.retrievalStatus();
  if (
    retrieval.lastDecision?.kind === "budget_denied"
    || retrieval.lastDecision?.kind === "no_provider_call"
    || retrieval.lastDecision?.kind === "unsupported"
  ) return false;
  return true;
}

export interface AtelierExtensionOptions {
  openCore?: (repositoryRoot: string) => AtelierCore;
}

let activeCore: AtelierCore | undefined;
let activeRoot: string | undefined;
let activeCoreFactory: (repositoryRoot: string) => AtelierCore = (repositoryRoot) => AtelierCore.open(repositoryRoot);
let reviewInProgress = false;
let providerDiscoveryAttempted = false;
let rawDiscoveryFallbackAllowed = false;
let stopIndexStatusUpdates: (() => void) | undefined;

function uniqueToolNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function ensureCodeToolsActive(pi: ExtensionAPI, core: AtelierCore): void {
  if (core.config.codeProvider === "disabled") return;
  const active = pi.getActiveTools();
  // Put Atelier retrieval tools first so the model sees the preferred discovery path
  // before generic Bash/read tools. Registered extension tools are not guaranteed to be
  // active until explicitly selected through Pi's active-tool API.
  pi.setActiveTools(uniqueToolNames([...CODE_AGENT_TOOLS, ...active]));
}

function resetDiscoveryRouting(): void {
  providerDiscoveryAttempted = false;
  rawDiscoveryFallbackAllowed = false;
}

function isBroadRawDiscovery(event: any): boolean {
  if (["grep", "find", "ls"].includes(event.toolName)) return true;
  if (event.toolName !== "bash" || typeof event.input?.command !== "string") return false;
  return /(^|[;&|\n]\s*)(?:rg|grep|find|fd|tree|ls)(?:\s|$)/.test(event.input.command.trim());
}

function coreFor(ctx: ExtensionContext): AtelierCore {
  const root = resolve(ctx.cwd);
  if (activeCore !== undefined && activeRoot === root) return activeCore;
  activeCore?.endRetrievalSession();
  activeCore?.close();
  activeCore = activeCoreFactory(root);
  activeRoot = root;
  resetDiscoveryRouting();
  return activeCore;
}

async function updateStatus(ctx: ExtensionContext, core = coreFor(ctx)): Promise<void> {
  try {
    const status = await core.status();
    const approved = status.currentPlanHash !== undefined && status.currentPlanHash === status.approvedPlanHash;
    const task = status.currentTaskId === undefined ? "no task" : status.currentTaskId;
    const indexing = core.code.indexingStatus();
    const index = indexing.active
      ? "indexing…"
      : indexing.state === "unknown"
        ? "index unknown"
        : `index ${indexing.state}`;
    const next = status.nextAction.length > 56 ? `${status.nextAction.slice(0, 53)}…` : status.nextAction;
    ctx.ui.setStatus(STATUS_KEY, `Atelier ${status.mode} · ${approved ? "approved" : "review"} · ${task} · ${index} · ${next}`);
  } catch (error) {
    ctx.ui.setStatus(STATUS_KEY, "Atelier unavailable");
    ctx.ui.notify(errorMessage(error), "error");
  }
}

function requestForTool(event: any, ctx: ExtensionContext, core: AtelierCore): ActionRequest {
  const snapshot = core.repository.snapshot();
  const currentTaskId = core.ledger.getState<string>("currentTaskId");
  const base = {
    actor: "agent" as const,
    repositorySnapshot: snapshot,
    ...(currentTaskId === undefined ? {} : { taskId: currentTaskId }),
  };

  if ([
    "read",
    "grep",
    "find",
    "ls",
    "atlr_code_status",
    "atlr_code_search",
    "atlr_code_symbols",
  ].includes(event.toolName)) {
    return {
      ...base,
      action: "read.repository",
      rationale: `Pi ${event.toolName} tool is read-only.`,
    };
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = typeof event.input?.path === "string"
      ? resolve(ctx.cwd, event.input.path)
      : undefined;
    return {
      ...base,
      action: "write.file",
      risk: "routine",
      ...(path === undefined ? {} : { paths: [path] }),
      rationale: `Pi ${event.toolName} tool modifies a file.`,
    };
  }

  if (event.toolName === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const classification = classifyShellCommand(command);
    return {
      ...base,
      action: classification.action,
      risk: classification.risk,
      command: [command],
      rationale: classification.rationale.join("; "),
    };
  }

  return {
    ...base,
    action: "command.execute",
    risk: "unknown",
    rationale: `Custom tool ${String(event.toolName)} is not declared read-only to Atelier.`,
  };
}

interface ToolAuthorization {
  decision: PolicyDecision;
  permissionGrantId?: string;
  response?: { block?: boolean; reason?: string };
}

function isDesignatedPlanWrite(request: ActionRequest, core: AtelierCore): boolean {
  return core.mode() === "plan"
    && request.action === "write.file"
    && (request.paths?.length ?? 0) > 0
    && request.paths?.every((path) => resolve(path) === resolve(core.config.planPath)) === true;
}

function matchedPermissionGrantId(decision: PolicyDecision): string | undefined {
  return decision.matchedRules.find((rule) => rule.startsWith("matched permission grant "))
    ?.slice("matched permission grant ".length);
}

async function authorizeTool(
  request: ActionRequest,
  ctx: ExtensionContext,
  core: AtelierCore,
): Promise<ToolAuthorization> {
  const decision = core.evaluate(request);
  if (decision.result === "allow") {
    const permissionGrantId = matchedPermissionGrantId(decision);
    return { decision, ...(permissionGrantId === undefined ? {} : { permissionGrantId }) };
  }
  if (decision.result === "deny") {
    core.ledger.append({
      kind: "policy.blocked",
      actor: "agent",
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: { decisionId: decision.id, action: request.action, reason: decision.reason },
    });
    return { decision, response: { block: true, reason: decision.reason } };
  }

  if (!ctx.hasUI || decision.requiredPermission === undefined) {
    return {
      decision,
      response: {
        block: true,
        reason: `${decision.reason} Interactive approval is unavailable in ${ctx.mode} mode.`,
      },
    };
  }

  const target = request.paths?.length
    ? `\nPaths: ${request.paths.join(", ")}`
    : request.command?.length
      ? `\nCommand: ${request.command.join(" ")}`
      : "";
  const approved = await ctx.ui.confirm(
    "Atelier approval required",
    `${decision.reason}\nAction: ${request.action}\nPermission: ${decision.requiredPermission}${target}\n\nAllow this operation once?`,
  );
  if (!approved) {
    core.ledger.append({
      kind: "policy.approval_denied",
      actor: "user",
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: { decisionId: decision.id, action: request.action },
    });
    return { decision, response: { block: true, reason: "The user denied this Atelier operation." } };
  }

  const grant = core.grant({
    permission: decision.requiredPermission,
    scope: "operation",
    actor: "user",
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    reason: `Approved once for ${request.action}`,
  });
  const allowed = core.evaluate(request);
  core.revoke(grant.id);
  core.ledger.append({
    kind: "policy.approval_consumed",
    actor: "user",
    ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
    payload: { grantId: grant.id, decisionId: allowed.id, action: request.action },
  });
  return {
    decision: allowed,
    permissionGrantId: grant.id,
    ...(allowed.result === "allow" ? {} : { response: { block: true, reason: allowed.reason } }),
  };
}

async function runEditorWithPi(
  ctx: ExtensionContext,
  core: AtelierCore,
  editor: ManualEditEditor,
): Promise<{ exitCode: number; error?: string; signal?: string; editor: ManualEditEditor }> {
  if (ctx.mode !== "tui") {
    throw new Error(`ManualEdit requires Pi TUI mode to open ${core.config.planPath}. Run \`atlr review\` in a terminal, then resume this session.`);
  }
  const result = await ctx.ui.custom<{ exitCode: number; error?: string; signal?: string }>((tui, _theme, _keybindings, done) => {
    tui.stop();
    let exitCode = 1;
    let error: string | undefined;
    let signal: string | undefined;
    try {
      const child = spawnSync(editor.executable, [...editor.args, core.config.planPath], {
        cwd: core.config.repositoryRoot,
        env: process.env,
        stdio: "inherit",
        shell: false,
        windowsHide: false,
      });
      exitCode = child.status ?? 1;
      error = child.error?.message;
      signal = child.signal ?? undefined;
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      tui.start();
      tui.requestRender(true);
    }
    done({
      exitCode,
      ...(error === undefined ? {} : { error }),
      ...(signal === undefined ? {} : { signal }),
    });
    return EMPTY_COMPONENT;
  });
  return { ...result, editor };
}

async function reviewPlan(
  ctx: ExtensionContext,
  core: AtelierCore,
): Promise<void> {
  if (reviewInProgress) return;
  reviewInProgress = true;
  core.ledger.setState("planAutoReviewPending", false);
  let startedManualEditId: string | undefined;
  try {
    ensurePlanDocument(core.config.planPath);
    const editor = resolveEditorCommand(core.config, ctx.isProjectTrusted());
    const started = core.beginPlanReview({ editor });
    startedManualEditId = started.id;
    const result = await runEditorWithPi(ctx, core, editor);
    if (result.exitCode !== 0 || result.error !== undefined || result.signal !== undefined) {
      core.cancelPlanReview(started.id, {
        status: result.signal === undefined ? "failed" : "interrupted",
        exitCode: result.exitCode,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        ...(result.error === undefined ? {} : { error: result.error }),
      });
      throw new Error(`Editor exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`);
    }

    const review = core.completePlanReview(started.id, { exitCode: result.exitCode });
    const parsed = core.parsePlan();
    const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    let reconciliation: Awaited<ReturnType<AtelierCore["reconcilePlan"]>> | undefined;
    let reconciliationError: string | undefined;
    try {
      reconciliation = await core.reconcilePlan(false);
    } catch (error) {
      reconciliationError = errorMessage(error);
    }
    core.ledger.append({
      kind: review.accepted ? "plan.reviewed" : "plan.review_blocked",
      actor: "user",
      repositorySnapshot: core.repository.snapshot(),
      payload: {
        path: core.config.planPath,
        editor: result.editor,
        beforeHash: review.beforeHash,
        afterHash: review.afterHash,
        changed: review.changed,
        accepted: review.accepted,
        driftStatus: review.driftStatus,
        structuralDiff: review.structuralDiff,
        diagnostics: parsed.diagnostics,
      },
    });
    await updateStatus(ctx, core);

    ctx.ui.notify(
      manualEditSummary(review, parsed.diagnostics, reconciliation, reconciliationError),
      errors.length > 0 || (reconciliation?.conflicts.length ?? 0) > 0 ? "warning" : "info",
    );
  } catch (error) {
    if (
      startedManualEditId !== undefined
      && core.ledger.getManualEdit(startedManualEditId)?.status === "started"
    ) {
      core.cancelPlanReview(startedManualEditId, {
        status: "failed",
        error: errorMessage(error),
      });
    }
    core.ledger.append({
      kind: "plan.review_failed",
      actor: "system",
      repositorySnapshot: core.repository.snapshot(),
      payload: { path: core.config.planPath, error: errorMessage(error) },
    });
    ctx.ui.notify(errorMessage(error), "error");
  } finally {
    reviewInProgress = false;
  }
}

function planInstruction(core: AtelierCore, objective: string): string {
  return `[Atelier PLAN MODE]\n\n` +
    `Investigate the repository without modifying source code, dependencies, repository state, or task-provider state. ` +
    `Write or update the implementation plan only at ${core.config.planPath}. ` +
    "Ensure one focused semantic discovery exists before repository inspection. If Working State already contains a current scoped inventory, inspect and reuse it with atlr_code_status instead of duplicating the search; otherwise call atlr_code_search once. Inspect the compact inventory before any additional retrieval. " +
    "Use atlr_code_symbols only for exact identifiers the inventory marks unresolved, and use built-in read for known or returned paths. " +
    "Do not use broad rg, grep, find, fd, tree, or ls discovery unless Atelier reports unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence. Cache hits and budget denial never permit raw fallback. " +
    "Use stable task IDs, explicit dependencies, scope, validation steps, and observable completion criteria. " +
    "Do not ask the user to describe textual plan edits after the draft; Atelier will open the plan in their configured editor. " +
    `When the draft is complete, stop.\n\nObjective: ${objective || "Create an implementation plan for the current request."}`;
}

function manualEditSummary(
  review: ReturnType<AtelierCore["completePlanReview"]>,
  diagnostics: ReturnType<AtelierCore["parsePlan"]>["diagnostics"],
  reconciliation?: Awaited<ReturnType<AtelierCore["reconcilePlan"]>>,
  reconciliationError?: string,
): string {
  const diff = review.structuralDiff;
  return [
    `ManualEdit ${review.id}: ${review.accepted ? "accepted" : "blocked"}`,
    `Plan hash: ${review.afterHash ?? review.beforeHash}`,
    `Structural diff: added ${diff?.added.join(", ") || "none"}; removed ${diff?.removed.join(", ") || "none"}; changed ${diff?.changed.map((item) => `${item.id}(${item.fields.join(",")})`).join(", ") || "none"}`,
    `Diagnostics: ${diagnostics.length === 0 ? "none" : diagnostics.map((item) => `${item.level}:${item.code} ${item.message}`).join("; ")}`,
    ...(reconciliation === undefined
      ? [`Reconciliation preview unavailable: ${reconciliationError ?? "unknown error"}`]
      : [
          `Reconciliation digest: ${reconciliation.digest}`,
          `Operations: ${reconciliation.operations.length}`,
          ...reconciliation.operations.map((operation) => `- ${operation.kind}: ${operation.planTaskId}`),
          ...reconciliation.conflicts.map((conflict) => `CONFLICT: ${conflict}`),
        ]),
  ].join("\n");
}

function preparationSummary(
  core: AtelierCore,
  prepared: Awaited<ReturnType<AtelierCore["execution"]["prepare"]>>,
): string {
  const first = core.parsePlan().tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.dependencies.length === 0)
    .sort((left, right) => left.task.priority - right.task.priority || left.index - right.index)[0]?.task;
  const retirements = prepared.reconciliation.operations.filter((operation) => operation.kind === "retire");
  return [
    `Plan hash: ${prepared.approval.planHash}`,
    `Provider: ${prepared.approval.provider.name}${prepared.approval.provider.version ? ` ${prepared.approval.provider.version}` : ""}`,
    `Reconciliation digest: ${prepared.approval.reconciliationDigest}`,
    `Operations: ${prepared.reconciliation.operations.length}`,
    ...prepared.reconciliation.operations.map((operation) => `- ${operation.kind}: ${operation.planTaskId}`),
    `Retirements: ${retirements.length}${retirements.length === 0 ? "" : ` (${retirements.map((operation) => operation.planTaskId).join(", ")})`}`,
    `Proposed first task: ${first === undefined ? "none" : `${first.id} — ${first.title}`}`,
  ].join("\n");
}

async function approveAndReconcile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  core: AtelierCore,
): Promise<void> {
  await ctx.waitForIdle();
  let providerStatus = await core.taskProvider.status();
  if (providerStatus.available && !providerStatus.initialized) {
    const initialize = await ctx.ui.confirm(
      "Initialize task provider",
      `Initialize ${providerStatus.provider} as a separate preparation step?`,
    );
    if (!initialize) return;
    await core.execution.initializeProvider(true);
    providerStatus = await core.taskProvider.status();
  }
  if (!providerStatus.available || !providerStatus.initialized) {
    ctx.ui.notify(providerStatus.reason ?? `${providerStatus.provider} is unavailable or uninitialized.`, "error");
    return;
  }

  let prepared;
  try {
    prepared = await core.execution.prepare();
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }
  if (prepared.reconciliation.conflicts.length > 0) {
    ctx.ui.notify(`Task reconciliation has ${prepared.reconciliation.conflicts.length} conflict(s).`, "error");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Approve exact execution transaction",
    `${preparationSummary(core, prepared)}\n\nApprove and apply this exact transaction?`,
  );
  if (!confirmed) {
    await core.execution.approveAndApply(prepared.approval.id, false);
    return;
  }

  try {
    const transition = await core.execution.approveAndApply(prepared.approval.id, true);
    core.ledger.setState("planAutoReviewPending", false);
    await updateStatus(ctx, core);
    pi.sendUserMessage(
      `[Atelier] Plan revision ${transition.approval.planHash} is approved and task ${transition.task?.id ?? "unknown"} is active. ` +
        `Execution grant ${transition.executionGrant?.id ?? "unknown"} authorizes only this task/workspace and conveys no action permission. ` +
        "Inspect current source, stay within scope, and obtain independently required permissions for mutations.",
    );
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  }
}

export function registerAtelierExtension(pi: ExtensionAPI, options: AtelierExtensionOptions = {}): void {
  activeCoreFactory = options.openCore ?? ((repositoryRoot) => AtelierCore.open(repositoryRoot));
  pi.registerTool({
    name: "atlr_code_status",
    label: "Atelier Code Status",
    description: "Inspect provider health plus the current retrieval session inventory, freshness, decisions, remaining budgets, deduplication, and truncation before requesting more evidence or considering raw scanning.",
    promptSnippet: "Inspect Atelier provider health and the compact evidence inventory before any additional retrieval",
    promptGuidelines: [
      "Inspect the returned inventory before another search. Raw scanning is available only for unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence—not for cache hits or budget denial.",
    ],
    parameters: objectSchema({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const core = coreFor(ctx);
        const workspace = core.codeWorkspace();
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
        const providerAllowsFallback = status.available === false
          || status.healthy === false
          || status.indexState === "stale"
          || status.indexState === "failed"
          || status.degraded === true;
        if (providerAllowsFallback) {
          providerDiscoveryAttempted = true;
          rawDiscoveryFallbackAllowed = true;
        }
        const text = [
          `Provider: ${status.identity.name}${status.identity.version ? ` ${status.identity.version}` : ""}`,
          `Available: ${status.available}`,
          `Healthy: ${status.healthy}`,
          `Index: ${status.indexState}`,
          `Capabilities: ${status.capabilities.join(", ") || "none"}`,
          ...(status.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
          ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
          "",
          retrievalText(retrieval),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { status, workspaceId: workspace.id, retrieval } };
      } catch (error) {
        rawDiscoveryFallbackAllowed = true;
        return codeToolError(error);
      }
    },
  });

  pi.registerTool({
    name: "atlr_code_search",
    label: "Atelier Code Search",
    description: "Run one focused semantic discovery through Atelier, or reuse current scoped evidence without a provider call. Returns provenance, compact inventory, decision, remaining budgets, deduplication, freshness, and truncation.",
    promptSnippet: "Start with one focused semantic discovery, inspect its inventory, then read returned paths directly",
    promptGuidelines: [
      "Use exactly one focused semantic discovery before broad raw scans. Call atlr_code_search only when Working State does not already contain current scoped semantic evidence; never duplicate an existing discovery.",
      "Before another search, inspect the returned inventory; Atelier will reuse covered evidence or recommend no provider call.",
      "Use built-in read for every known or returned path. Do not search again merely to inspect a known file.",
      "Raw scanning is allowed only after unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence; budget denial is not fallback permission.",
    ],
    parameters: objectSchema({
      query: stringSchema("Natural-language or identifier-oriented code search query."),
      focus: stringSchema("Preferred evidence class.", ["auto", "source", "tests", "docs", "all"]),
      mode: stringSchema("Retrieval mode.", ["auto", "lexical", "semantic", "hybrid"]),
      limit: integerSchema("Maximum results to return.", 1, 20),
    }, ["query"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const input = params as { query: string; focus?: "auto" | "source" | "tests" | "docs" | "all"; mode?: "auto" | "lexical" | "semantic" | "hybrid"; limit?: number };
        const core = coreFor(ctx);
        const workspace = core.codeWorkspace();
        providerDiscoveryAttempted = true;
        const results = await core.code.search({
          workspace,
          text: input.query,
          ...(input.focus === undefined ? {} : { focus: input.focus }),
          mode: input.mode ?? "semantic",
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
        const genuinelyEmpty = results.length === 0
          && (retrieval.lastDecision?.kind === "provider_call" || retrieval.lastDecision?.kind === "invalidated");
        rawDiscoveryFallbackAllowed = genuinelyEmpty || status.available === false || status.healthy === false ||
          status.indexState === "stale" || status.indexState === "failed" || status.degraded === true ||
          results.some((hit) => hit.provenance.degraded === true);
        const readGuidance = results.length === 0
          ? ""
          : `\n\nNext: use built-in read for the returned path${results.length === 1 ? "" : "s"}; do not issue another search to inspect known files.`;
        const text = (results.length === 0
          ? `No Atelier code matches for: ${input.query}\nProvider: ${status.identity.name} · index ${status.indexState}`
          : [
              `Atelier code search: ${input.query}`,
              `Provider: ${status.identity.name} · index ${status.indexState} · ${results.length} result(s)`,
              "",
              ...results.map(codeHitText),
            ].join("\n"))
          + readGuidance
          + `\n\n${retrievalText(retrieval)}`;
        return {
          content: [{ type: "text", text }],
          details: {
            query: input.query,
            provider: status.identity,
            indexState: status.indexState,
            status,
            retrieval,
            results: results.map((hit) => ({
              rank: hit.rank,
              repositoryId: hit.repositoryId,
              repositoryName: hit.repositoryName,
              path: hit.path,
              startLine: hit.startLine,
              endLine: hit.endLine,
              symbol: hit.symbol,
              reference: hit.reference,
              provenance: hit.provenance,
              provenanceObservations: hit.provenanceObservations,
              atelierObservations: hit.atelierObservations,
            })),
          },
        };
      } catch (error) {
        const core = activeCore;
        rawDiscoveryFallbackAllowed = core === undefined ? true : providerFailureAllowsRawFallback(core);
        return codeToolError(error, core);
      }
    },
  });

  pi.registerTool({
    name: "atlr_code_symbols",
    label: "Atelier Symbol Search",
    description: "Resolve an exact identifier only when the current scoped inventory marks it unresolved after semantic discovery. Resolved or unplanned identifiers avoid a provider call.",
    promptSnippet: "Use exact symbol lookup only for identifiers marked unresolved in the current inventory",
    promptGuidelines: [
      "Do not call atlr_code_symbols before one focused semantic discovery.",
      "Call it only for an identifier listed under unresolved symbols; use built-in read for returned definition paths.",
    ],
    parameters: objectSchema({
      query: stringSchema("Symbol name or identifier fragment."),
      limit: integerSchema("Maximum symbol results to return.", 1, 20),
    }, ["query"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const input = params as { query: string; limit?: number };
        const core = coreFor(ctx);
        const workspace = core.codeWorkspace();
        providerDiscoveryAttempted = true;
        const results = await core.code.symbols({
          workspace,
          text: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
        rawDiscoveryFallbackAllowed = retrieval.lastDecision?.kind === "no_provider_call"
          || retrieval.lastDecision?.kind === "exact_reuse"
          ? false
          : results.length === 0 || status.available === false || status.healthy === false
            || status.indexState === "stale" || status.indexState === "failed" || status.degraded === true;
        const text = (results.length === 0
          ? retrieval.lastDecision?.kind === "no_provider_call"
            ? `No symbol provider call: ${retrieval.lastDecision.reason}`
            : `No Atelier symbols matched: ${input.query}`
          : `${results.map(codeHitText).join("\n\n")}\n\nNext: use built-in read for the returned definition path.`)
          + `\n\n${retrievalText(retrieval)}`;
        return {
          content: [{ type: "text", text }],
          details: {
            query: input.query,
            status,
            retrieval,
            results: results.map((hit) => ({
              rank: hit.rank,
              repositoryId: hit.repositoryId,
              repositoryName: hit.repositoryName,
              path: hit.path,
              startLine: hit.startLine,
              endLine: hit.endLine,
              symbol: hit.symbol,
              reference: hit.reference,
              provenance: hit.provenance,
              provenanceObservations: hit.provenanceObservations,
              atelierObservations: hit.atelierObservations,
            })),
          },
        };
      } catch (error) {
        const core = activeCore;
        rawDiscoveryFallbackAllowed = core === undefined ? true : providerFailureAllowsRawFallback(core);
        return codeToolError(error, core);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    resetDiscoveryRouting();
    const core = coreFor(ctx);
    core.beginRetrievalSession();
    ensureCodeToolsActive(pi, core);
    stopIndexStatusUpdates?.();
    stopIndexStatusUpdates = core.code.onIndexStatus(() => {
      void updateStatus(ctx, core);
    });
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution resume failed closed: ${errorMessage(error)}`, "error");
    }
    await updateStatus(ctx, core);
    if (core.config.codeProvider !== "disabled") {
      // Indexing is deliberately detached from session startup. CodeService owns
      // the single in-flight operation; searches and /code-index join it.
      void core.code.ensureIndex(core.codeWorkspace()).catch((error) => {
        ctx.ui.notify(`Code indexing failed: ${errorMessage(error)}`, "error");
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    stopIndexStatusUpdates?.();
    stopIndexStatusUpdates = undefined;
    activeCore?.interruptPendingExecutionEvidence("Pi session shut down before tool completion.");
    activeCore?.endRetrievalSession();
    activeCore?.close();
    activeCore = undefined;
    activeRoot = undefined;
    reviewInProgress = false;
    resetDiscoveryRouting();
  });

  pi.on("tool_call", async (event, ctx) => {
    const core = coreFor(ctx);
    if (
      core.mode() === "plan" &&
      core.config.codeProvider !== "disabled" &&
      isBroadRawDiscovery(event) &&
      (!providerDiscoveryAttempted || !rawDiscoveryFallbackAllowed)
    ) {
      return {
        block: true,
        reason: providerDiscoveryAttempted
          ? core.code.retrievalStatus().lastDecision?.kind === "budget_denied"
            ? "Atelier retrieval budget was denied. Inspect and reuse the current inventory; budget exhaustion does not permit raw scanning."
            : "Atelier code intelligence returned usable evidence. Read the exact returned paths instead of broad grep/find scanning."
          : "Plan mode requires provider-first discovery. Call atlr_code_search before broad grep/find/rg/ls scanning.",
      };
    }
    const request = requestForTool(event, ctx, core);
    const authorization = await authorizeTool(request, ctx, core);
    if (
      authorization.response === undefined
      && request.action !== "read.repository"
      && !isDesignatedPlanWrite(request, core)
    ) {
      try {
        core.beginExecutionEvidence({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          request,
          policyDecisionId: authorization.decision.id,
          ...(authorization.permissionGrantId === undefined ? {} : { permissionGrantId: authorization.permissionGrantId }),
        });
      } catch (error) {
        return { block: true, reason: `Unable to start durable execution evidence: ${errorMessage(error)}` };
      }
    }
    await updateStatus(ctx, core);
    return authorization.response;
  });

  pi.on("tool_result", async (event, ctx) => {
    const core = coreFor(ctx);
    const pending = core.ledger.getExecutionEvidence(event.toolCallId);
    if (pending !== undefined && pending.status === "started") {
      const text = event.content
        .filter((item: { type: string; text?: string }): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item: { type: "text"; text: string }) => item.text)
        .join("\n");
      const interrupted = event.isError === true && /abort|cancel|interrupt|signal/i.test(text);
      const evidence = core.completeExecutionEvidence(event.toolCallId, {
        status: interrupted ? "interrupted" : event.isError === true ? "failed" : "succeeded",
        ...(event.isError === true ? { error: text || "Tool execution failed." } : {}),
      });
      if (evidence?.action === "task.close" && evidence.status === "succeeded") {
        await core.observeTaskClosure();
      }
    }
    await updateStatus(ctx, core);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const core = coreFor(ctx);
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution validation failed closed: ${errorMessage(error)}`, "error");
    }
    ensureCodeToolsActive(pi, core);
    const state = await core.buildWorkingState();
    const retrieval = core.code.retrievalStatus();
    if (state.retrievalQueries.length > 0 || retrieval.decisions.length > 0) {
      providerDiscoveryAttempted = true;
      rawDiscoveryFallbackAllowed = retrieval.lastDecision?.kind === "budget_denied"
        || retrieval.lastDecision?.kind === "no_provider_call"
        || retrieval.lastDecision?.kind === "exact_reuse"
        ? false
        : state.codeEvidence.length === 0
          || state.retrievalQueries.some((query) => query.degraded)
          || state.codeEvidence.some((item) => item.degraded || item.indexState === "stale" || item.indexState === "failed");
    }
    const activeContext = core.workingStateBuilder.toMarkdown(state);
    const retrievalInstruction = core.config.codeProvider === "disabled"
      ? "Atelier code intelligence is disabled; use exact built-in read/grep/find operations as needed."
      : "Efficient provider-first retrieval is enforced: ensure one focused semantic discovery exists, reusing a current Working State inventory instead of duplicating it; inspect that inventory before another request, use atlr_code_symbols only for identifiers marked unresolved, and use built-in read for known or returned paths. Broad grep/find/rg/ls is allowed only after unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence—not after cache reuse or budget denial.";
    const modeInstruction = state.mode === "plan"
      ? `Only ${core.config.planPath} may be modified. Task-provider and source mutations are prohibited until approval. Read-only repository investigation never requires approval. ${retrievalInstruction}`
      : state.mode === "investigate"
        ? `Investigate only. Any mutation requires a distinct Atelier approval. ${retrievalInstruction}`
        : `Implement only the selected task and approved scope. Routine changes, validations, task updates, and local commits inside the active repository are approved by default. Ask only before destructive operations, external side effects, publication, or work outside the repository. Do not report implementation complete with uncommitted changes: run the appropriate validation and create a local Jujutsu change or Git commit before stopping. ${retrievalInstruction}`;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Atelier enforced working state\n\n${modeInstruction}\n\n${activeContext}`,
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const core = coreFor(ctx);
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution validation failed closed before compaction: ${errorMessage(error)}`, "error");
    }
    const state = await core.buildWorkingState();
    const summary = `${core.workingStateBuilder.toMarkdown(state)}\n` +
      "Conversation history is non-authoritative. Resume from the current task, approved plan, active permissions, repository snapshot, corrections, and validation evidence above.";
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const core = coreFor(ctx);
    if (core.mode() === "act") {
      const status = await core.status();
      const changedPaths = core.repository.changedPaths()
        .filter((path) => path !== ".atelier" && !path.startsWith(".atelier/"));
      if (status.currentTaskId !== undefined && changedPaths.length > 0) {
        const fingerprint = core.repository.snapshot().dirtyFingerprint;
        if (core.ledger.getState<string>("completionGuardFingerprint") !== fingerprint) {
          core.ledger.setState("completionGuardFingerprint", fingerprint);
          pi.sendUserMessage(
            `[Atelier completion guard] ${status.currentTaskId} still has ${changedPaths.length} uncommitted repository change(s). ` +
              "Do not report completion yet. Run the required validation, inspect the final diff, then create a local Jujutsu change or Git commit containing only the approved task work. " +
              "Publication still requires explicit approval.",
          );
        }
      } else {
        core.ledger.deleteState("completionGuardFingerprint");
      }
      return;
    }
    if (core.mode() !== "plan" || reviewInProgress) return;
    if (core.ledger.getState<boolean>("planAutoReviewPending") !== true) return;
    if (!existsSync(core.config.planPath)) return;
    await reviewPlan(ctx, core);
  });

  pi.registerCommand("status", {
    description: "Show Atelier workflow, plan, task, and policy state",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const status = await core.status();
      ctx.ui.notify(
        `Mode: ${status.mode}\nPlan: ${status.currentPlanHash === status.approvedPlanHash ? "approved" : "not approved"}\n` +
          `Task: ${status.currentTaskId ?? "none"}\nProvider: ${status.taskProvider.provider} (${status.taskProvider.initialized ? "ready" : "not initialized"})\n` +
          `Next action: ${status.nextAction}`,
        "info",
      );
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter guarded plan mode; the completed draft opens in the configured editor",
    handler: async (args, ctx) => {
      const core = coreFor(ctx);
      ensureCodeToolsActive(pi, core);
      ensurePlanDocument(core.config.planPath);
      const baseline = hashFile(core.config.planPath);
      core.ledger.setState("planAutoReviewBaselineHash", baseline);
      core.ledger.setState("planAutoReviewPending", true);
      core.beginPlan(args.trim(), { metadata: { baseline } });
      await updateStatus(ctx, core);
      pi.sendUserMessage(planInstruction(core, args.trim()));
    },
  });

  pi.registerCommand("review", {
    description: "Open the current Atelier plan in the configured editor",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const core = coreFor(ctx);
      core.setMode("plan");
      await reviewPlan(ctx, core);
    },
  });

  pi.registerCommand("approve", {
    description: "Approve the reviewed plan, reconcile Beads, and enter act mode",
    handler: async (_args, ctx) => {
      await approveAndReconcile(pi, ctx, coreFor(ctx));
    },
  });

  pi.registerCommand("execute", {
    description: "Explicitly activate the next or requested approved-plan task",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const core = coreFor(ctx);
      const requestedTaskId = args.trim() || undefined;
      const previous = core.ledger.listExecutionGrants()[0];
      if (previous === undefined) {
        ctx.ui.notify("No prior approved execution exists for task continuation.", "error");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Activate approved-plan task",
        `Plan hash: ${previous.planHash}\nPrevious task: ${previous.taskId}\nRequested next task: ${requestedTaskId ?? "next ready in reviewed plan order"}\n\nActivate explicitly?`,
      );
      if (!confirmed) return;
      try {
        const transition = await core.execution.startNextTask(true, requestedTaskId);
        if (transition === undefined) return;
        ctx.ui.notify(`Activated ${transition.task.id} with execution grant ${transition.executionGrant.id}.`, "info");
        await updateStatus(ctx, core);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("cancel", {
    description: "Cancel the active execution without closing its task",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const core = coreFor(ctx);
      const reason = args.trim() || "User cancelled execution through Pi /cancel.";
      const cancelled = core.execution.cancel(reason);
      if (cancelled === undefined) {
        ctx.ui.notify("No active execution exists to cancel.", "info");
        return;
      }
      ctx.ui.notify(`Cancelled execution ${cancelled.id}; task ${cancelled.taskId} remains open.`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("ready", {
    description: "Show or select provider-reported ready work",
    handler: async (args, ctx) => {
      const core = coreFor(ctx);
      const ready = await core.taskProvider.ready();
      if (ready.length === 0) {
        ctx.ui.notify("No ready task is available.", "info");
        return;
      }
      const requested = args.trim();
      let selected = requested ? ready.find((task) => task.id === requested) : undefined;
      if (selected === undefined && ctx.hasUI) {
        const labels = ready.map((task) => `${task.id} · P${task.priority} · ${task.title}`);
        const choice = await ctx.ui.select("Select Atelier task", labels);
        const index = choice === undefined ? -1 : labels.indexOf(choice);
        selected = index < 0 ? undefined : ready[index];
      }
      if (selected === undefined) {
        ctx.ui.notify(ready.map((task) => `${task.id}: ${task.title}`).join("\n"), "info");
        return;
      }
      core.ledger.setState("currentTaskId", selected.id);
      core.ledger.append({
        kind: "task.selected",
        actor: "user",
        taskId: selected.id,
        payload: { provider: core.taskProvider.name },
      });
      ctx.ui.notify(`Selected ${selected.id}: ${selected.title}`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("state", {
    description: "Show the deterministic Atelier Working State",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const state = await core.buildWorkingState();
      ctx.ui.notify(core.workingStateBuilder.toMarkdown(state), "info");
    },
  });

  pi.registerCommand("code-status", {
    description: "Show Atelier code-provider health, capabilities, and index state",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const status = await core.code.status(undefined, core.codeWorkspace());
      const retrieval = core.code.retrievalStatus();
      if (!status.available || !status.healthy || status.indexState === "stale" || status.indexState === "failed" || status.degraded === true) {
        providerDiscoveryAttempted = true;
        rawDiscoveryFallbackAllowed = true;
      }
      ctx.ui.notify([
        `Provider: ${status.identity.name}`,
        `Available: ${status.available}`,
        `Healthy: ${status.healthy}`,
        `Index: ${status.indexState}`,
        `Capabilities: ${status.capabilities.join(", ") || "none"}`,
        ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
        "",
        retrievalText(retrieval),
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("code-index", {
    description: "Start or join the Atelier background code-index operation",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const state = await core.code.ensureIndex(core.codeWorkspace());
      ctx.ui.notify(`Code index state: ${state}`, "info");
    },
  });

  pi.registerCommand("code-search", {
    description: "Search code across the configured Atelier workspace",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /code-search QUERY", "warning");
        return;
      }
      const core = coreFor(ctx);
      providerDiscoveryAttempted = true;
      const workspace = core.codeWorkspace();
      const results = await core.code.search({ workspace, text: query, mode: "semantic", limit: 10 });
      const status = await core.code.status(undefined, workspace);
      const retrieval = core.code.retrievalStatus();
      rawDiscoveryFallbackAllowed = (results.length === 0
        && (retrieval.lastDecision?.kind === "provider_call" || retrieval.lastDecision?.kind === "invalidated"))
        || !status.available || !status.healthy || status.indexState === "stale" || status.indexState === "failed"
        || status.degraded === true || results.some((item) => item.provenance.degraded === true);
      const message = (results.length === 0
        ? "No code matches."
        : `${results.map((item) => `${item.repositoryName}:${item.path}${item.startLine === undefined ? "" : `:${item.startLine}`}\n${item.preview ?? ""} [${item.provenance.provider.name}/${item.provenance.indexState}]`).join("\n\n")}\n\nUse built-in read for returned paths.`)
        + `\n\n${retrievalText(retrieval)}`;
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("code-symbols", {
    description: "Search symbols through the configured Atelier code provider",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /code-symbols QUERY", "warning");
        return;
      }
      const core = coreFor(ctx);
      providerDiscoveryAttempted = true;
      const workspace = core.codeWorkspace();
      const results = await core.code.symbols({ workspace, text: query, limit: 20 });
      const status = await core.code.status(undefined, workspace);
      const retrieval = core.code.retrievalStatus();
      rawDiscoveryFallbackAllowed = retrieval.lastDecision?.kind !== "no_provider_call"
        && retrieval.lastDecision?.kind !== "exact_reuse"
        && (results.length === 0 || !status.available || !status.healthy || status.indexState === "stale"
          || status.indexState === "failed" || status.degraded === true);
      const message = (results.length === 0
        ? retrieval.lastDecision?.kind === "no_provider_call"
          ? `No symbol provider call: ${retrieval.lastDecision.reason}`
          : "No symbols matched."
        : `${results.map((item) => `${item.symbol ?? "symbol"} ${item.repositoryName}:${item.path}${item.startLine === undefined ? "" : `:${item.startLine}`}`).join("\n")}\n\nUse built-in read for returned paths.`)
        + `\n\n${retrievalText(retrieval)}`;
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("changed", {
    description: "Show paths changed in the current Jujutsu workspace",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const paths = core.repository.changedPaths();
      ctx.ui.notify(["Changed paths:", ...(paths.length === 0 ? ["- none"] : paths.map((path) => `- ${path}`))].join("\n"), "info");
    },
  });

  pi.registerCommand("validate", {
    description: "List or run configured Atelier validations",
    handler: async (args, ctx) => {
      const core = coreFor(ctx);
      const name = args.trim();
      if (!name) {
        const manifest = core.validation.manifest();
        const message = Object.entries(manifest.validations)
          .map(([key, value]) => `${key}: ${value.command.join(" ")}`)
          .join("\n") || "No validations configured.";
        ctx.ui.notify(message, "info");
        return;
      }
      if (name === "plan" || name === "focused") {
        if (name === "plan") {
          const selection = core.selectFocusedValidation();
          ctx.ui.notify(
            selection.noMatch
              ? `Focused selection ${selection.id}: no configured validations matched.`
              : `Focused selection ${selection.id}:\n${selection.selected.map((item) => `${item.name}: ${item.reason}${item.required ? " (required)" : ""}`).join("\n")}`,
            "info",
          );
          return;
        }
        const selection = core.selectFocusedValidation();
        const results = [];
        for (const item of selection.selected) {
          const executionGrant = core.ledger.getActiveExecutionGrant();
          if (executionGrant !== undefined) core.grant({
            permission: "validation.focused",
            scope: "operation",
            taskId: executionGrant.taskId,
            reason: `Explicit Pi focused validation ${item.name}`,
          });
          const signal = contextSignal(ctx);
          results.push(await core.runValidation(item.name, {
            selectionId: selection.id,
            ...(signal === undefined ? {} : { signal }),
          }));
        }
        ctx.ui.notify(results.length === 0 ? "No focused validations matched." : results.map((item) => `${item.name}: ${item.status} (${item.durationMs} ms)`).join("\n"), results.some((item) => item.status !== "passed") ? "error" : "info");
        return;
      }
      const action = core.validation.action(name);
      const executionGrant = core.ledger.getActiveExecutionGrant();
      if (executionGrant !== undefined) core.grant({
        permission: action === "validation.focused" ? "validation.focused" : "validation.full_suite",
        scope: "operation",
        taskId: executionGrant.taskId,
        reason: `Explicit Pi validation ${name}`,
      });
      const signal = contextSignal(ctx);
      const evidence = await core.runValidation(name, signal === undefined ? {} : { signal });
      ctx.ui.notify(`${name}: ${evidence.status} (${evidence.durationMs} ms)`, evidence.status === "passed" ? "info" : "error");
    },
  });

  pi.registerCommand("evidence", {
    description: "Show current and stale validation evidence",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const items = core.validation.list({
        currentSnapshot: core.repository.snapshot(),
        currentChangedPaths: core.repository.changedPaths()
          .filter((path) => path !== ".atelier" && !path.startsWith(".atelier/")),
      });
      const message = items.length === 0
        ? "No validation evidence."
        : items.map((item) => `${item.name}: ${item.status} (${item.stale ? "stale" : "current"})`).join("\n");
      ctx.ui.notify(message, "info");
    },
  });

}

export default function atelierExtension(pi: ExtensionAPI): void {
  registerAtelierExtension(pi);
}

function contextSignal(ctx: ExtensionContext): AbortSignal | undefined {
  return (ctx as ExtensionContext & { signal?: AbortSignal }).signal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
