import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  ensurePlanDocument,
  sourceSnapshotFingerprint,
  hashFile,
  resolveEditorCommand,
  runInteractiveProcess,
  createStatusView,
  statusViewText,
  runSandboxedShell,
  resolveSandboxBackend,
  type ManualEditEditor,
  type Permission,
} from "../../../packages/core/src/index.ts";
import {
  codeHitText,
  codeToolError,
  conciseProviderDetail,
  integerSchema,
  objectSchema,
  retrievalText,
  stringSchema,
} from "./code-tool-presentation.ts";
import { toolExecutionOutcome } from "./execution-outcome.ts";
import { preparationSummary } from "./approval-presentation.ts";
import { ensureAtelierToolsActive, isBroadRawDiscovery } from "./tool-activation.ts";
import { authorizeTool, authorizeWorkspaceEffects, isDesignatedPlanWrite, requestForTool } from "./tool-authorization.ts";
import { effectsForTool, effectsForUserBash } from "./tool-effects.ts";
import {
  eventInputText,
  turnPolicyBlockReason,
  turnPolicyInstruction,
  turnToolPolicy,
  type TurnToolPolicy,
} from "./turn-tool-policy.ts";
import { ATELIER_VALIDATION_TOOL, registerValidationTool } from "./validation-tool.ts";
import {
  executionGrantText,
  installAtelierFooter,
  planStatusText,
  vcsStatusText,
  atelierStatusSummary,
} from "./status-presentation.ts";
import {
  ATELIER_COMMIT_TOOL,
  ATELIER_STATE_TOOL,
  ATELIER_TASK_CLOSE_TOOL,
  registerWorkflowTools,
} from "./workflow-tools.ts";

const STATUS_KEY = "atlr";
const WORKFLOW_AGENT_TOOLS = [
  ATELIER_VALIDATION_TOOL,
  ATELIER_STATE_TOOL,
  ATELIER_COMMIT_TOOL,
  ATELIER_TASK_CLOSE_TOOL,
] as const;
const CODE_RETRIEVAL_TOOLS = [
  "atlr_code_search",
  "atlr_code_symbols",
  "atlr_code_status",
] as const;
const EMPTY_COMPONENT = {
  render: (_width: number): string[] => [],
  invalidate: (): void => {},
};

export interface AtelierExtensionOptions {
  openCore?: (repositoryRoot: string) => AtelierCore;
}

interface ExtensionSessionState {
  core?: AtelierCore;
  root?: string;
  reviewInProgress: boolean;
  advisorySent: boolean;
  stopIndexStatusUpdates?: () => void;
  lastCompletionNotice?: string;
  turnPolicy?: TurnToolPolicy;
}

const SESSION_STATES = new WeakMap<object, ExtensionSessionState>();

function sessionKey(ctx: ExtensionContext): object {
  const extended = ctx as ExtensionContext & { sessionManager?: object; session?: object };
  return extended.sessionManager ?? extended.session ?? ctx;
}

function sessionState(ctx: ExtensionContext): ExtensionSessionState {
  const key = sessionKey(ctx);
  const existing = SESSION_STATES.get(key);
  if (existing !== undefined) return existing;
  const created: ExtensionSessionState = { reviewInProgress: false, advisorySent: false };
  SESSION_STATES.set(key, created);
  return created;
}

function coreFor(ctx: ExtensionContext, openCore: (repositoryRoot: string) => AtelierCore): AtelierCore {
  const state = sessionState(ctx);
  const root = resolve(ctx.cwd);
  if (state.core !== undefined && state.root === root) return state.core;
  if (state.core !== undefined) {
    throw new Error(
      `The Pi session root changed from ${state.root ?? "unknown"} to ${root}. `
      + "Start a new session so Atelier can close the prior repository state before opening another root.",
    );
  }
  state.core = openCore(root);
  state.root = root;
  state.reviewInProgress = false;
  state.advisorySent = false;
  delete state.lastCompletionNotice;
  return state.core;
}

async function replaceCore(
  ctx: ExtensionContext,
  openCore: (repositoryRoot: string) => AtelierCore,
): Promise<AtelierCore> {
  const state = sessionState(ctx);
  if (state.core !== undefined) {
    state.core.interruptPendingExecutionEvidence("Pi replaced the active Atelier core.");
    state.core.endRetrievalSession();
    await state.core.close();
  }
  delete state.core;
  delete state.root;
  return coreFor(ctx, openCore);
}

async function updateStatus(ctx: ExtensionContext, core: AtelierCore): Promise<void> {
  try {
    const status = await core.status();
    const indexing = core.code.indexingStatus();
    const index = indexing.active ? "indexing…" : indexing.state === "unknown" ? "index unknown" : `index ${indexing.state}`;
    const value = `${atelierStatusSummary(status)} · ${index}`;
    if (core.config.footer === "disabled") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setFooter?.(undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, value);
    installAtelierFooter(ctx, status, value, core.config.footer);
  } catch (error) {
    ctx.ui.setStatus(STATUS_KEY, "Atelier unavailable");
    ctx.ui.notify(errorMessage(error), "error");
  }
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
    void (async () => {
      try {
        const child = await runInteractiveProcess({
          command: editor.executable,
          args: [...editor.args, core.config.planPath],
          cwd: core.config.repositoryRoot,
        });
        done({
          exitCode: child.exitCode,
          ...(child.error === undefined ? {} : { error: child.error }),
          ...(child.signal === undefined ? {} : { signal: child.signal }),
        });
      } catch (caught) {
        done({ exitCode: 1, error: errorMessage(caught) });
      } finally {
        tui.start();
        tui.requestRender(true);
      }
    })();
    return EMPTY_COMPONENT;
  });
  return { ...result, editor };
}

async function reviewPlan(
  ctx: ExtensionContext,
  core: AtelierCore,
): Promise<void> {
  const extensionState = sessionState(ctx);
  if (extensionState.reviewInProgress) return;
  extensionState.reviewInProgress = true;
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
    extensionState.reviewInProgress = false;
  }
}

function planInstruction(core: AtelierCore, objective: string): string {
  return `[Atelier PLAN MODE]\n\n` +
    `Investigate the repository without modifying source code, dependencies, repository state, or task-provider state. ` +
    `Write or update the implementation plan only at ${core.config.planPath}. ` +
    "Read exact repository paths named by the objective directly; do not force semantic discovery for known files or trivial local edits. When an implementation location is unknown, reuse current scoped inventory with atlr_code_status or call atlr_code_search once, then inspect the compact inventory before another request. " +
    "Use atlr_code_symbols only for unresolved identifiers during autonomous discovery, and use built-in read for known or returned paths. " +
    "Prefer provider evidence before broad rg, grep, find, fd, tree, or ls discovery, but use exact raw inspection when provider evidence is insufficient or the request requires it. " +
    "Use the smallest independently deliverable task graph: keep tests and implementation together unless they can be completed and accepted separately. Use stable task IDs, explicit dependencies, scope, validation steps, observable completion criteria, and an exact execution object in each atlr:task metadata comment naming every writable repository-relative path, declared validation, dependency permission, full-suite permission, and local-change permission. " +
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

async function approveAndReconcile(
  _pi: ExtensionAPI,
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
  const summary = preparationSummary(core, prepared);
  ctx.ui.notify(summary, "info");
  ctx.ui.setWidget?.(
    "atelier-approval",
    ["Atelier exact execution transaction", "", ...summary.split("\n")],
    { placement: "aboveEditor" },
  );
  let confirmed: boolean;
  try {
    confirmed = await ctx.ui.confirm(
      "Approve exact execution transaction",
      "Review the complete transaction and capability summary shown above. Approve and apply exactly this transaction?",
    );
  } finally {
    ctx.ui.setWidget?.("atelier-approval", undefined);
  }
  if (!confirmed) {
    await core.execution.approveAndApply(prepared.approval.id, false);
    return;
  }

  try {
    const transition = await core.execution.approveAndApply(prepared.approval.id, true);
    core.ledger.setState("planAutoReviewPending", false);
    await updateStatus(ctx, core);
    ctx.ui.notify(
      `Approved plan revision ${transition.approval.planHash}. Task ${transition.task?.id ?? "unknown"} is active with execution grant ${transition.executionGrant?.id ?? "unknown"}. ` +
        "Atelier is idle; send an explicit implementation instruction when you are ready. Only the reviewed typed capabilities are active.",
      "info",
    );
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  }
}

export function registerAtelierExtension(pi: ExtensionAPI, options: AtelierExtensionOptions = {}): void {
  const openCore = options.openCore ?? ((repositoryRoot: string) => AtelierCore.open(repositoryRoot));
  const getCore = (ctx: ExtensionContext): AtelierCore => coreFor(ctx, openCore);
  const reopenCore = (ctx: ExtensionContext): Promise<AtelierCore> => replaceCore(ctx, openCore);
  registerValidationTool(pi, getCore);
  registerWorkflowTools(pi, getCore);
  pi.registerTool({
    name: "atlr_shell",
    label: "Atelier Sandboxed Shell",
    description: "Run a shell command inside the current Atelier workspace using the configured OS sandbox. Workspace writes are allowed; external filesystem writes, credential paths, and network access are blocked by default.",
    promptSnippet: "Use the Atelier sandboxed shell for bounded build, test, format, and inspection commands",
    parameters: objectSchema({ command: stringSchema("Shell command to execute inside the workspace."), allowNetwork: { type: "boolean", description: "Allow network access for this one sandboxed invocation." } }, ["command"]),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      const input = params as { command: string; allowNetwork?: boolean };
      try {
        const result = await runSandboxedShell({ workspace: core.config.workspaceRoot, command: input.command, backend: core.config.sandboxBackend, ...(input.allowNetwork === undefined ? {} : { allowNetwork: input.allowNetwork }), signal });
        const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || `Command exited ${result.exitCode}.`;
        return { content: [{ type: "text", text }], details: result };
      } catch (error) {
        const sandbox = resolveSandboxBackend(core.config.sandboxBackend);
        return { content: [{ type: "text", text: `Sandboxed shell unavailable: ${errorMessage(error)}` }], details: { sandbox, error: errorMessage(error) } };
      }
    },
  });
  pi.registerTool({
    name: "atlr_code_status",
    label: "Atelier Code Status",
    description: "Inspect provider health plus the current retrieval session inventory, freshness, decisions, remaining budgets, deduplication, and truncation before requesting more evidence or considering raw scanning.",
    promptSnippet: "Inspect Atelier provider health and the compact evidence inventory before any additional retrieval",
    promptGuidelines: [
      "Inspect the returned inventory before another search. Prefer provider evidence first, but raw inspection remains available through typed reads or an explicitly approved shell operation; budget denial does not grant shell permission.",
    ],
    parameters: objectSchema({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      try {
        const workspace = core.codeWorkspace();
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
        const text = [
          `Provider: ${status.identity.name}${status.identity.version ? ` ${status.identity.version}` : ""}`,
          `Available: ${status.available}`,
          `Healthy: ${status.healthy}`,
          `Index: ${status.indexState}`,
          `Capabilities: ${status.capabilities.join(", ") || "none"}`,
          ...(status.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
          ...conciseProviderDetail(status.detail),
          "",
          retrievalText(retrieval),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { status, workspaceId: workspace.id, retrieval } };
      } catch (error) {
        return codeToolError(error, core);
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
      "Prefer provider evidence before broad raw scanning. Raw inspection remains available through typed reads or an explicitly approved shell operation; budget denial does not grant shell permission.",
    ],
    parameters: objectSchema({
      query: stringSchema("Natural-language or identifier-oriented code search query."),
      focus: stringSchema("Preferred evidence class.", ["auto", "source", "tests", "docs", "all"]),
      mode: stringSchema("Retrieval mode.", ["auto", "lexical", "semantic", "hybrid"]),
      limit: integerSchema("Maximum results to return.", 1, 20),
    }, ["query"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      try {
        const input = params as { query: string; focus?: "auto" | "source" | "tests" | "docs" | "all"; mode?: "auto" | "lexical" | "semantic" | "hybrid"; limit?: number };
        const workspace = core.codeWorkspace();
        const results = await core.code.search({
          workspace,
          text: input.query,
          ...(input.focus === undefined ? {} : { focus: input.focus }),
          mode: input.mode ?? "semantic",
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
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
      const core = getCore(ctx);
      try {
        const input = params as { query: string; limit?: number };
        const workspace = core.codeWorkspace();
        const results = await core.code.symbols({
          workspace,
          text: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace);
        const retrieval = core.code.retrievalStatus();
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
        return codeToolError(error, core);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const extensionState = sessionState(ctx);
    extensionState.advisorySent = false;
    delete extensionState.turnPolicy;
    const core = getCore(ctx);
    core.beginRetrievalSession();
    ensureAtelierToolsActive(pi, core, WORKFLOW_AGENT_TOOLS, CODE_RETRIEVAL_TOOLS);
    extensionState.stopIndexStatusUpdates?.();
    extensionState.stopIndexStatusUpdates = core.code.onIndexStatus(() => { void updateStatus(ctx, core); });
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution resume failed closed: ${errorMessage(error)}`, "error");
    }
    await updateStatus(ctx, core);
    if (core.config.codeProvider !== "disabled") {
      void core.code.ensureIndex(core.codeWorkspace()).catch((error) => {
        ctx.ui.notify(`Code indexing failed: ${errorMessage(error)}`, "error");
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setFooter?.(undefined);
    const extensionState = sessionState(ctx);
    extensionState.stopIndexStatusUpdates?.();
    delete extensionState.stopIndexStatusUpdates;
    extensionState.core?.interruptPendingExecutionEvidence("Pi session shut down before tool completion.");
    extensionState.core?.endRetrievalSession();
    if (extensionState.core !== undefined) await extensionState.core.close();
    delete extensionState.core;
    delete extensionState.root;
    extensionState.reviewInProgress = false;
    extensionState.advisorySent = false;
    delete extensionState.lastCompletionNotice;
    delete extensionState.turnPolicy;
  });

  pi.on("input", (event, ctx) => {
    const text = eventInputText(event);
    if (text === undefined || text.startsWith("/")) return;
    const state = sessionState(ctx);
    const policy = turnToolPolicy(text);
    if (policy === undefined) delete state.turnPolicy;
    else state.turnPolicy = policy;
  });

  pi.on("tool_call", async (event, ctx) => {
    const core = getCore(ctx);
    const extensionState = sessionState(ctx);
    const turnBlock = turnPolicyBlockReason(String(event.toolName), extensionState.turnPolicy);
    if (turnBlock !== undefined) {
      const taskId = core.ledger.getState<string>("currentTaskId");
      core.ledger.append({
        kind: "policy.user_constraint_blocked",
        actor: "user",
        ...(taskId === undefined ? {} : { taskId }),
        repositorySnapshot: core.repository.snapshot(),
        payload: { toolName: event.toolName, reason: turnBlock },
      });
      return { block: true, reason: turnBlock };
    }
    if (core.mode() === "plan"
      && core.config.providerFirstRetrieval === "advisory"
      && core.config.codeProvider !== "disabled"
      && isBroadRawDiscovery(event)
      && !extensionState.advisorySent) {
      extensionState.advisorySent = true;
      core.ledger.append({
        kind: "retrieval.raw_discovery_advisory",
        actor: "system",
        repositorySnapshot: core.repository.snapshot(),
        payload: { toolName: event.toolName, guidance: "Prefer current code-provider evidence or a focused provider query before broad raw discovery." },
      });
      ctx.ui.notify("Atelier advisory: prefer current provider evidence or one focused code query before broad raw discovery. This is guidance, not an authorization block.", "warning");
    }
    const workspaceAuthorization = await authorizeWorkspaceEffects(effectsForTool(event, ctx), ctx, core);
    if (workspaceAuthorization.response !== undefined) return workspaceAuthorization.response;
    const request = requestForTool(event, ctx, core);
    const authorization = await authorizeTool(request, ctx, core, { workspaceApproved: workspaceAuthorization.approvedOnce === true });
    if (
      authorization.response === undefined
      && request.action !== "read.repository"
      && !isDesignatedPlanWrite(request, core)
      && core.ledger.getActiveExecutionGrant() !== undefined
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

  pi.on("user_bash", async (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    const authorization = await authorizeWorkspaceEffects(effectsForUserBash(command, ctx.cwd), ctx, getCore(ctx));
    return authorization.response;
  });

  pi.on("tool_result", async (event, ctx) => {
    const core = getCore(ctx);
    const pending = core.ledger.getExecutionEvidence(event.toolCallId);
    if (pending !== undefined && pending.status === "started") {
      const text = event.content
        .filter((item: { type: string; text?: string }): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item: { type: "text"; text: string }) => item.text)
        .join("\n");
      const outcome = toolExecutionOutcome(event, contextSignal(ctx));
      const evidence = core.completeExecutionEvidence(event.toolCallId, outcome);
      if (evidence?.action === "task.close" && evidence.status === "succeeded") {
        await core.observeTaskClosure();
      }
    }
    await updateStatus(ctx, core);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const core = getCore(ctx);
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution validation failed closed: ${errorMessage(error)}`, "error");
    }
    ensureAtelierToolsActive(pi, core, WORKFLOW_AGENT_TOOLS, CODE_RETRIEVAL_TOOLS);
    const state = await core.buildWorkingState();
    const retrieval = core.code.retrievalStatus();
    const activeContext = core.workingStateBuilder.toMarkdown(state);
    const retrievalInstruction = core.config.codeProvider === "disabled"
      ? "Atelier code intelligence is disabled; use exact built-in read/grep/find operations as needed."
      : "Provider-first retrieval is advisory: prefer current scoped evidence or one focused semantic query, inspect the compact inventory before another request, and read known paths directly. Raw repository inspection remains available when provider evidence is insufficient or the user requests it.";
    const modeInstruction = core.execution.isPaused()
      ? `Execution is paused. Repository reads remain available, but agent mutation is denied until the user runs /atelier-resume. Do not continue implementation automatically. ${retrievalInstruction}`
      : state.mode === "plan"
      ? `Only ${core.config.planPath} may be modified. Task-provider and source mutations are prohibited until approval. Typed repository reads inside approved roots do not require approval; generic shell remains unconfined and requires one-operation approval. ${retrievalInstruction}`
      : state.mode === "investigate"
        ? `Investigate only. Any mutation requires a distinct Atelier approval. ${retrievalInstruction}`
        : `Implement only the selected task and reviewed capability bundle. Typed in-repository writes, declared validations through atlr_validate, task closure and one local change are authorized for the active task. Authorization is not an instruction: obey the user's latest constraints, including requests not to run validation, Bash, commit, or continue. Generic shell is unconfined and always requires one-operation approval; destructive operations, external effects, publication, and out-of-root access also require separate approval. An incomplete task may remain paused; completion is enforced only when task closure is requested. ${retrievalInstruction}`;
    const policyInstruction = turnPolicyInstruction(sessionState(ctx).turnPolicy);
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Atelier enforced working state\n\n${modeInstruction}${policyInstruction}\n\n${activeContext}`,
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const core = getCore(ctx);
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
    const core = getCore(ctx);
    const extensionState = sessionState(ctx);
    if (core.mode() === "act") {
      const readiness = core.taskClosureReadiness();
      const grant = core.ledger.getActiveExecutionGrant();
      if (grant !== undefined && !readiness.ready) {
        const notice = `${grant.id}:${sourceSnapshotFingerprint(core.repository.snapshot())}:${readiness.reason}`;
        if (extensionState.lastCompletionNotice !== notice) {
          extensionState.lastCompletionNotice = notice;
          ctx.ui.notify(
            `Task ${grant.taskId} remains active but incomplete: ${readiness.reason} The current turn has ended; use /validate, /review-diff, /commit, /close, /atelier-pause, or /cancel when appropriate.`,
            "warning",
          );
        }
      } else {
        delete extensionState.lastCompletionNotice;
      }
      delete extensionState.turnPolicy;
      return;
    }
    delete extensionState.turnPolicy;
    if (core.mode() !== "plan" || sessionState(ctx).reviewInProgress) return;
    if (core.ledger.getState<boolean>("planAutoReviewPending") !== true) return;
    if (!existsSync(core.config.planPath)) return;
    await reviewPlan(ctx, core);
  });


  pi.registerCommand("review-diff", {
    description: "Display and record review of the exact current task diff",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const preview = core.previewFinalDiff();
      const approved = await ctx.ui.confirm(
        "Review exact Atelier task diff",
        `${preview.diff.trimEnd()}

Changed paths: ${preview.changedPaths.join(", ")}
Diff SHA-256: ${preview.diffHash}

Record this exact diff as reviewed?`,
      );
      if (!approved) {
        ctx.ui.notify("Final diff review was not recorded.", "warning");
        return;
      }
      const review = core.reviewFinalDiff(preview.diffHash);
      ctx.ui.notify(`Reviewed ${review.changedPaths.length} path(s); diff ${review.diffHash}.`, "info");
    },
  });

  pi.registerCommand("commit", {
    description: "Create the required local task commit or finalized Jujutsu change",
    handler: async (args, ctx) => {
      const message = args.trim();
      if (!message) { ctx.ui.notify("Usage: /commit MESSAGE", "warning"); return; }
      const result = getCore(ctx).commitActiveTask(message);
      ctx.ui.notify(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}`, "info");
    },
  });

  pi.registerCommand("close", {
    description: "Close the active task after the authoritative completion predicate passes",
    handler: async (args, ctx) => {
      const reason = args.trim() || "Completed with current Atelier evidence.";
      const result = await getCore(ctx).closeActiveTask(reason);
      ctx.ui.notify(`Closed ${result.task.id}; ${result.nextReady.length} approved-plan task(s) are ready.`, "info");
      await updateStatus(ctx, getCore(ctx));
    },
  });

  pi.registerCommand("status", {
    description: "Show Atelier workflow, plan, task, and policy state",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const status = await core.status();
      ctx.ui.notify(
        `Mode: ${status.mode}\nPlan: ${planStatusText(status)}\n` +
          `Task: ${status.currentTaskId ?? "none"}\nExecution grant: ${executionGrantText(status)}\n` +
          `Repository: ${vcsStatusText(status)}\n` +
          `Provider: ${status.taskProvider.provider} (${status.taskProvider.initialized ? "ready" : "not initialized"})\n` +
          `Next action: ${status.nextAction}`,
        "info",
      );
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter guarded plan mode; the completed draft opens in the configured editor",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      ensureAtelierToolsActive(pi, core, WORKFLOW_AGENT_TOOLS, CODE_RETRIEVAL_TOOLS);
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
      const core = getCore(ctx);
      core.setMode("plan");
      await reviewPlan(ctx, core);
    },
  });

  pi.registerCommand("approve", {
    description: "Approve the reviewed plan, reconcile Beads, and enter act mode",
    handler: async (_args, ctx) => {
      await approveAndReconcile(pi, ctx, getCore(ctx));
    },
  });

  pi.registerCommand("execute", {
    description: "Explicitly activate the next or requested approved-plan task",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const core = getCore(ctx);
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

  pi.registerCommand("atelier-stop", {
    description: "Abort only the current Atelier agent/tool turn",
    handler: async (_args, ctx) => {
      if (!abortContext(ctx)) {
        ctx.ui.notify("The current Pi host does not expose an active-turn abort operation.", "warning");
        return;
      }
      ctx.ui.notify("Stopped the current turn; the active task and execution grant remain available.", "info");
    },
  });

  pi.registerCommand("atelier-pause", {
    description: "Pause active execution and abort the current turn without revoking task capabilities",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      const reason = args.trim() || "User paused execution through Pi /atelier-pause.";
      const paused = core.execution.pause(reason);
      abortContext(ctx);
      if (paused === undefined) {
        ctx.ui.notify("No active execution exists to pause.", "info");
        return;
      }
      delete sessionState(ctx).lastCompletionNotice;
      ctx.ui.notify(`Paused execution ${paused.id}; task ${paused.taskId} remains active but agent mutations are disabled.`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("atelier-resume", {
    description: "Resume a paused Atelier execution without starting an agent turn",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const resumed = core.execution.resumePaused();
      if (resumed === undefined) {
        ctx.ui.notify("No active execution exists to resume.", "info");
        return;
      }
      ctx.ui.notify(`Execution ${resumed.id} is available again; task ${resumed.taskId} remains active.`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("cancel", {
    description: "Abort the current turn and cancel active execution without closing its task",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      const reason = args.trim() || "User cancelled execution through Pi /cancel.";
      const cancelled = core.execution.cancel(reason);
      abortContext(ctx);
      if (cancelled === undefined) {
        ctx.ui.notify("No active execution exists to cancel.", "info");
        return;
      }
      delete sessionState(ctx).lastCompletionNotice;
      ctx.ui.notify(`Cancelled execution ${cancelled.id}; task ${cancelled.taskId} remains open.`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("ready", {
    description: "Show or select provider-reported ready work",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
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
      const core = getCore(ctx);
      const state = await core.buildWorkingState();
      ctx.ui.notify(core.workingStateBuilder.toMarkdown(state), "info");
    },
  });

  pi.registerCommand("code-status", {
    description: "Show Atelier code-provider health, capabilities, and index state",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const status = await core.code.status(undefined, core.codeWorkspace());
      const retrieval = core.code.retrievalStatus();
      if (!status.available || !status.healthy || status.indexState === "stale" || status.indexState === "failed" || status.degraded === true) {
      }
      ctx.ui.notify([
        `Provider: ${status.identity.name}`,
        `Available: ${status.available}`,
        `Healthy: ${status.healthy}`,
        `Index: ${status.indexState}`,
        `Capabilities: ${status.capabilities.join(", ") || "none"}`,
        ...conciseProviderDetail(status.detail),
        "",
        retrievalText(retrieval),
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("code-index", {
    description: "Start or join the Atelier background code-index operation",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
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
      const core = getCore(ctx);
      const workspace = core.codeWorkspace();
      const results = await core.code.search({ workspace, text: query, mode: "semantic", limit: 10 });
      const retrieval = core.code.retrievalStatus();
      const message = (results.length === 0
        ? "No code matches."
        : `${results.map(codeHitText).join("\n\n")}\n\nUse built-in read for returned paths.`)
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
      const core = getCore(ctx);
      const workspace = core.codeWorkspace();
      const results = await core.code.symbols({ workspace, text: query, limit: 20, requireUnresolved: false });
      const retrieval = core.code.retrievalStatus();
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
      const core = getCore(ctx);
      const paths = core.repository.changedPaths();
      ctx.ui.notify(["Changed paths:", ...(paths.length === 0 ? ["- none"] : paths.map((path) => `- ${path}`))].join("\n"), "info");
    },
  });

  pi.registerCommand("validate", {
    description: "List or run configured Atelier validations",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
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
          const signal = contextSignal(ctx);
          results.push(await core.runValidation(item.name, {
            selectionId: selection.id,
            ...(signal === undefined ? {} : { signal }),
          }));
        }
        ctx.ui.notify(results.length === 0 ? "No focused validations matched." : results.map((item) => `${item.name}: ${item.status} (${item.durationMs} ms)`).join("\n"), results.some((item) => item.status !== "passed") ? "error" : "info");
        return;
      }
      const signal = contextSignal(ctx);
      const evidence = await core.runValidation(name, signal === undefined ? {} : { signal });
      ctx.ui.notify(`${name}: ${evidence.status} (${evidence.durationMs} ms)`, evidence.status === "passed" ? "info" : "error");
    },
  });

  pi.registerCommand("evidence", {
    description: "Show current and stale validation evidence",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
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

function abortContext(ctx: ExtensionContext): boolean {
  if (ctx.isIdle()) return true;
  const abort = (ctx as ExtensionContext & { abort?: () => void }).abort;
  if (abort === undefined) return false;
  abort();
  return true;
}

function contextSignal(ctx: ExtensionContext): AbortSignal | undefined {
  return (ctx as ExtensionContext & { signal?: AbortSignal }).signal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
