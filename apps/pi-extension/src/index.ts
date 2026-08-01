import { randomUUID } from "node:crypto";
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
  updatePlanTaskScopeFile,
  sourceSnapshotFingerprint,
  hashFile,
  resolveEditorCommand,
  createStatusView,
  statusViewText,
  rankPresentedHits,
  type ManualEditEditor,
  type AtelierStatus,
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
import { confirmApprovalDialog } from "./approval-dialog.ts";
import { commandOnPath, editorArguments, parseFileLocation, projectTree } from "./navigation.ts";
import { runInteractiveProcessWithPi } from "./interactive-process.ts";
import { planInstruction } from "./plan-instruction.ts";
import { contextCapsulePrompt, createAuthoritativeContextCapsule } from "./authoritative-context.ts";
import { createAtelierBashOperations } from "./bash-operations.ts";
import { ensureAtelierToolsActive, isBroadRawDiscovery } from "./tool-activation.ts";
import { authorizeShellEffects, authorizeTool, authorizeWorkspaceEffects, isDesignatedPlanWrite, requestForTool } from "./tool-authorization.ts";
import { effectsForTool, effectsForUserBash } from "./tool-effects.ts";
import {
  eventInputText,
  turnPolicyBlockReason,
  turnPolicyInstruction,
  turnToolPolicy,
  type TurnToolPolicy,
} from "./turn-tool-policy.ts";
import { ATELIER_VALIDATION_TOOL, registerValidationTool } from "./validation-tool.ts";
import { appendAtelierReport, registerAtelierReportRenderer } from "./report-presentation.ts";
import {
  changedMarkdown,
  evidenceMarkdown,
  focusedSelectionMarkdown,
  performanceMarkdown,
  readyTasksMarkdown,
  statusMarkdown,
  statusSummary,
  validationListMarkdown,
  validationResultsMarkdown,
  workflowMarkdown,
  workflowSummary,
  workflowStatusMarkdown,
} from "./command-reports.ts";
import {
  executionGrantText,
  planStatusText,
  vcsStatusText,
} from "./status-presentation.ts";
import { FooterStatusController } from "./footer-status-controller.ts";
import { registerCodeCommands } from "./code-commands.ts";
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
export interface AtelierExtensionOptions {
  openCore?: (repositoryRoot: string) => AtelierCore;
}

interface ExtensionSessionState {
  sessionId: string;
  core?: AtelierCore;
  root?: string;
  reviewInProgress: boolean;
  advisorySent: boolean;
  stopIndexStatusUpdates?: () => void;
  lastCompletionNotice?: string;
  turnPolicy?: TurnToolPolicy;
  authorizedShellToolCalls: Map<string, { allowUnsandboxed: boolean }>;
  footerStatus: FooterStatusController;
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
  const created: ExtensionSessionState = {
    sessionId: `pi-${randomUUID()}`,
    reviewInProgress: false,
    advisorySent: false,
    authorizedShellToolCalls: new Map<string, { allowUnsandboxed: boolean }>(),
    footerStatus: new FooterStatusController(),
  };
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
  state.footerStatus.resetRepository();
  return coreFor(ctx, openCore);
}

function updateStatus(ctx: ExtensionContext, core: AtelierCore, status?: AtelierStatus): Promise<void> {
  return sessionState(ctx).footerStatus.refresh(ctx, core, status);
}

function updateRuntimeFooter(ctx: ExtensionContext): void {
  sessionState(ctx).footerStatus.renderRuntime(ctx);
}

async function showPhase(ctx: ExtensionContext, message: string): Promise<void> {
  ctx.ui.setWorkingMessage?.(`Atelier: ${message}…`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function clearPhase(ctx: ExtensionContext): void {
  ctx.ui.setWorkingMessage?.();
}


async function runEditorWithPi(
  ctx: ExtensionContext,
  core: AtelierCore,
  editor: ManualEditEditor,
): Promise<{ exitCode: number; error?: string; signal?: string; editor: ManualEditEditor }> {
  if (ctx.mode !== "tui") {
    throw new Error(`ManualEdit requires Pi TUI mode to open ${core.config.planPath}. Run \`atlr review\` in a terminal, then resume this session.`);
  }
  const result = await runInteractiveProcessWithPi(ctx, {
    command: editor.executable,
    args: [...editor.args, core.config.planPath],
    cwd: core.config.repositoryRoot,
    purpose: "ManualEdit",
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
    await updateStatus(ctx, core);
  }
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
  await showPhase(ctx, "checking task provider");
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
    await showPhase(ctx, "preparing exact transaction");
    prepared = await core.execution.prepare();
  } catch (error) {
    clearPhase(ctx);
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }
  if (prepared.reconciliation.conflicts.length > 0) {
    ctx.ui.notify(`Task reconciliation has ${prepared.reconciliation.conflicts.length} conflict(s).`, "error");
    return;
  }
  const summary = preparationSummary(core, prepared);
  clearPhase(ctx);
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
      "Review the complete transaction and task-constraint summary shown above. Approve and apply exactly this transaction?",
    );
  } finally {
    ctx.ui.setWidget?.("atelier-approval", undefined);
  }
  if (!confirmed) {
    await core.execution.approveAndApply(prepared.approval.id, false);
    return;
  }

  try {
    const transition = await core.execution.approveAndApply(prepared.approval.id, true, {
      onPhase: async (phase) => {
        const labels = {
          revalidate: "revalidating exact transaction",
          reconcile: "applying task reconciliation",
          converge: "verifying reconciliation convergence",
          activate: "activating approved task",
        } as const;
        await showPhase(ctx, labels[phase]);
      },
    });
    core.ledger.setState("planAutoReviewPending", false);
    ctx.ui.notify(
      `Approved plan revision ${transition.approval.planHash}. Task ${transition.task?.id ?? "unknown"} is active with execution grant ${transition.executionGrant?.id ?? "unknown"}. ` +
        "Atelier is idle; send an explicit implementation instruction when you are ready. Only the reviewed task constraints are active.",
      "info",
    );
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  } finally {
    clearPhase(ctx);
  }
}

export function registerAtelierExtension(pi: ExtensionAPI, options: AtelierExtensionOptions = {}): void {
  const openCore = options.openCore ?? ((repositoryRoot: string) => AtelierCore.open(repositoryRoot, { ...(process.env.ATELIER_WORKSPACE_ROOT === undefined ? {} : { workspaceRoot: process.env.ATELIER_WORKSPACE_ROOT }) }));
  const getCore = (ctx: ExtensionContext): AtelierCore => {
    const state = sessionState(ctx);
    const thinkingLevel = ctx.thinkingLevel
      ?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
    state.footerStatus.setRuntime({
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(ctx.model?.id === undefined && ctx.model?.name === undefined
        ? {}
        : { modelName: ctx.model.id ?? ctx.model.name }),
    });
    return coreFor(ctx, openCore);
  };
  const reopenCore = (ctx: ExtensionContext): Promise<AtelierCore> => replaceCore(ctx, openCore);
  registerAtelierReportRenderer(pi);
  registerValidationTool(pi, getCore);
  registerWorkflowTools(pi, getCore);
  pi.registerTool({
    name: "bash",
    label: "bash (Atelier policy-controlled)",
    description: "Run a shell command through Atelier effect analysis and workspace policy. An OS sandbox is used when available; otherwise the exact command requires an explicit one-operation approval before unsandboxed execution.",
    promptSnippet: "Use Atelier's policy-controlled shell; prefer typed tools and expect explicit approval when no OS sandbox is available",
    parameters: objectSchema({
      command: stringSchema("Shell command to execute."),
      timeout: { type: "number", description: "Optional timeout in seconds." },
    }, ["command"]),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const core = getCore(ctx);
      const state = sessionState(ctx);
      const authorization = state.authorizedShellToolCalls.get(toolCallId);
      state.authorizedShellToolCalls.delete(toolCallId);
      if (authorization === undefined) {
        return {
          content: [{ type: "text", text: "Atelier shell execution failed closed because no matching workspace-policy authorization was recorded." }],
          details: { error: "missing_workspace_authorization" },
          isError: true,
        };
      }
      const input = params as { command: string; timeout?: number };
      const chunks: string[] = [];
      const operations = createAtelierBashOperations({
        workspace: core.config.workspaceRoot,
        backend: core.config.sandboxBackend,
        allowUnsandboxed: authorization.allowUnsandboxed,
      });
      try {
        const result = await operations.exec(input.command, ctx.cwd, {
          onData(chunk) {
            const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            chunks.push(text);
            onUpdate?.({ content: [{ type: "text", text: chunks.join("") }] });
          },
          ...(signal === undefined ? {} : { signal }),
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        });
        const text = chunks.join("").trim() || `Command exited ${result.exitCode ?? 1}.`;
        return { content: [{ type: "text", text }], details: result, ...(result.exitCode === 0 ? {} : { isError: true }) };
      } catch (error) {
        return { content: [{ type: "text", text: `Sandboxed shell failed closed: ${errorMessage(error)}` }], details: { error: errorMessage(error) }, isError: true };
      }
    },
  });
  pi.registerTool({
    name: "atlr_code_status",
    label: "Atelier Code Status",
    description: "Inspect provider health plus the current retrieval session inventory, freshness, decisions, remaining budgets, deduplication, and truncation before requesting more evidence or considering raw scanning.",
    promptSnippet: "Inspect Atelier provider health and the compact evidence inventory before any additional retrieval",
    promptGuidelines: [
      "Inspect the returned inventory before another search. Prefer provider evidence first, but raw inspection remains available through typed reads or a concrete shell operation evaluated by the workspace recoverability policy; budget denial does not bypass that policy.",
    ],
    parameters: objectSchema({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      try {
        const workspace = await core.observeCodeWorkspace({ ...(signal === undefined ? {} : { signal }), operation: "code-status" });
        const status = await core.code.status(undefined, workspace, { force: true });
        sessionState(ctx).footerStatus.recordProvider(core, status);
        await updateStatus(ctx, core);
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
        sessionState(ctx).footerStatus.markProviderOffline();
        await updateStatus(ctx, core);
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
      "Prefer provider evidence before broad raw scanning. Raw inspection remains available through typed reads or a concrete shell operation evaluated by the workspace recoverability policy; budget denial does not bypass that policy.",
    ],
    parameters: objectSchema({
      query: stringSchema("Natural-language or identifier-oriented code search query."),
      focus: stringSchema("Preferred evidence class.", ["auto", "source", "tests", "docs", "all"]),
      mode: stringSchema("Retrieval mode.", ["auto", "lexical", "semantic", "hybrid"]),
      limit: integerSchema("Maximum results to return.", 1, 20),
    }, ["query"]),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      try {
        const input = params as { query: string; focus?: "auto" | "source" | "tests" | "docs" | "all"; mode?: "auto" | "lexical" | "semantic" | "hybrid"; limit?: number };
        const workspace = await core.observeCodeWorkspace({ ...(signal === undefined ? {} : { signal }), operation: "code-search" });
        const results = rankPresentedHits(await core.code.search({
          workspace,
          text: input.query,
          ...(input.focus === undefined ? {} : { focus: input.focus }),
          mode: input.mode ?? "semantic",
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }));
        const status = await core.code.status(undefined, workspace, { force: true });
        sessionState(ctx).footerStatus.recordProvider(core, status);
        await updateStatus(ctx, core);
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
        sessionState(ctx).footerStatus.markProviderOffline();
        await updateStatus(ctx, core);
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const core = getCore(ctx);
      try {
        const input = params as { query: string; limit?: number };
        const workspace = await core.observeCodeWorkspace({ ...(signal === undefined ? {} : { signal }), operation: "code-symbols" });
        const results = await core.code.symbols({
          workspace,
          text: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace, { force: true });
        sessionState(ctx).footerStatus.recordProvider(core, status);
        await updateStatus(ctx, core);
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
        sessionState(ctx).footerStatus.markProviderOffline();
        await updateStatus(ctx, core);
        return codeToolError(error, core);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const extensionState = sessionState(ctx);
    extensionState.footerStatus.enable();
    extensionState.advisorySent = false;
    delete extensionState.turnPolicy;
    const core = getCore(ctx);
    core.beginRetrievalSession();
    ensureAtelierToolsActive(pi, core, WORKFLOW_AGENT_TOOLS, CODE_RETRIEVAL_TOOLS);
    extensionState.stopIndexStatusUpdates?.();
    extensionState.stopIndexStatusUpdates = core.code.onIndexStatus((indexing) => {
      extensionState.footerStatus.recordIndex(core, indexing);
      const indexLabel = indexing.active || indexing.state === "building"
        ? "index building"
        : `index ${indexing.state}`;
      ctx.ui.setStatus(STATUS_KEY, `Atelier starting · ${indexLabel}`);
      void updateStatus(ctx, core);
    });
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution resume failed closed: ${errorMessage(error)}`, "error");
    }
    await updateStatus(ctx, core);
    if (core.config.codeProvider !== "disabled") {
      void (async () => {
        const workspace = await core.observeCodeWorkspace({ operation: "code-index-startup" });
        const state = await core.code.ensureIndex(workspace);
        extensionState.footerStatus.recordWorkspaceIndexed(workspace);
        return state;
      })().catch((error) => {
        extensionState.footerStatus.markProviderOffline();
        ctx.ui.notify(`Code indexing failed: ${errorMessage(error)}`, "error");
        void updateStatus(ctx, core);
      });
    }
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const state = sessionState(ctx);
    state.footerStatus.setRuntime({ thinkingLevel: String(event.level) });
    updateRuntimeFooter(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const state = sessionState(ctx);
    const modelName = event.model?.id ?? event.model?.name;
    if (modelName !== undefined) state.footerStatus.setRuntime({ modelName });
    updateRuntimeFooter(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await updateStatus(ctx, getCore(ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const extensionState = sessionState(ctx);
    await extensionState.footerStatus.disable();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setFooter?.(undefined);
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
    extensionState.footerStatus.resetRepository();
  });

  pi.on("input", (event, ctx) => {
    const text = eventInputText(event);
    if (text === undefined || text.startsWith("/")) return;
    const core = getCore(ctx);
    core.invalidateRepositoryObservation();
    // Slash handlers own their status observation. Ordinary input refreshes
    // external drift before the next turn without duplicating command work.
    void updateStatus(ctx, core);
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
    const effects = effectsForTool(event, ctx, core);
    const signal = contextSignal(ctx);
    await showPhase(ctx, "reading repository state");
    const observation = await core.observeRepository({
      paths: effects.flatMap((effect) => effect.path === undefined ? [] : [effect.path]),
      ...(signal === undefined ? {} : { signal }),
      operation: "permission",
    });
    const request = requestForTool(event, ctx, core, effects, observation);
    const authorization = await authorizeTool(request, ctx, core);
    if (authorization.response !== undefined) {
      clearPhase(ctx);
      return authorization.response;
    }

    // Reject operations that violate the active workflow before creating a
    // recovery checkpoint or asking the user to approve an execution mode.
    const authorizationOptions = {
      toolCallId: event.toolCallId,
      sessionId: extensionState.sessionId,
      observation,
    };
    const workspaceAuthorization = event.toolName === "bash"
      ? await authorizeShellEffects(effects, ctx, core, authorizationOptions)
      : await authorizeWorkspaceEffects(effects, ctx, core, authorizationOptions);
    if (workspaceAuthorization.response !== undefined) {
      clearPhase(ctx);
      return workspaceAuthorization.response;
    }
    if (event.toolName === "bash") extensionState.authorizedShellToolCalls.set(event.toolCallId, {
      allowUnsandboxed: "allowUnsandboxed" in workspaceAuthorization && workspaceAuthorization.allowUnsandboxed === true,
    });
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
          workflowDecisionId: authorization.decision.id,
          repositoryObservation: workspaceAuthorization.observation,
          ...(workspaceAuthorization.checkpointId === undefined ? {} : { checkpointId: workspaceAuthorization.checkpointId }),
        });
      } catch (error) {
        clearPhase(ctx);
        return { block: true, reason: `Unable to start durable execution evidence: ${errorMessage(error)}` };
      }
    }
    clearPhase(ctx);
    // Tool completion owns the next footer observation. Do not delay tool
    // start by waiting for a second full status refresh here.
    return authorization.response;
  });

  pi.on("user_bash", async (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    const core = getCore(ctx);
    const effects = effectsForUserBash(command, ctx.cwd, core);
    const signal = contextSignal(ctx);
    await showPhase(ctx, "reading repository state");
    const observation = await core.observeRepository({
      paths: effects.flatMap((effect) => effect.path === undefined ? [] : [effect.path]),
      ...(signal === undefined ? {} : { signal }),
      operation: "permission",
    });
    const authorization = await authorizeShellEffects(effects, ctx, core, {
      toolCallId: `user-bash-${randomUUID()}`,
      sessionId: sessionState(ctx).sessionId,
      observation,
    });
    clearPhase(ctx);
    if (authorization.response !== undefined) return authorization.response;
    return { operations: createAtelierBashOperations({
      workspace: core.config.workspaceRoot, backend: core.config.sandboxBackend,
      allowUnsandboxed: authorization.allowUnsandboxed,
      onComplete: () => {
        core.invalidateRepositoryObservation();
        return updateStatus(ctx, core);
      },
    }) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const core = getCore(ctx);
    core.invalidateRepositoryObservation();
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
      ? `Only ${core.config.planPath} may be modified by the agent. Task-provider and source mutations are prohibited until exact plan approval. Ordinary non-secret reads inside the immutable session workspace are allowed; every structured or shell effect is evaluated for workspace containment and recoverability. ${retrievalInstruction}`
      : state.mode === "investigate"
        ? `Investigate only. Any mutation requires a distinct Atelier approval. ${retrievalInstruction}`
        : `Implement only the selected task and reviewed task constraints. Ordinary contained and recoverable structured or shell effects are allowed by the workspace policy; likely-secret access, privilege escalation, workspace escape, and indeterminate or unrecoverable effects require one concrete approval. Authorization is not an instruction: obey the user's latest constraints, including requests not to run validation, Bash, commit, or continue. An incomplete task may remain paused; completion is enforced only when task closure is requested. ${retrievalInstruction}`;
    const policyInstruction = turnPolicyInstruction(sessionState(ctx).turnPolicy);
    const capsule = createAuthoritativeContextCapsule({
      modeInstruction,
      turnPolicyInstruction: policyInstruction,
      workingStateMarkdown: activeContext,
    });
    core.ledger.setState("authoritativeContextCapsule", {
      digest: capsule.digest,
      workingStateId: state.stateId,
      createdAt: new Date().toISOString(),
    });
    await updateStatus(ctx, core);
    return { systemPrompt: contextCapsulePrompt(event.systemPrompt, capsule) };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const core = getCore(ctx);
    try {
      await core.execution.resume();
    } catch (error) {
      ctx.ui.notify(`Execution validation failed closed before compaction: ${errorMessage(error)}`, "error");
    }
    const state = await core.buildWorkingState();
    const capsule = createAuthoritativeContextCapsule({
      modeInstruction: "Resume only from this durable Atelier state. Do not infer workflow authority from the discarded transcript.",
      workingStateMarkdown: core.workingStateBuilder.toMarkdown(state),
    });
    return {
      compaction: {
        summary: `${capsule.markdown}\n\nAtelier context digest: ${capsule.digest}`,
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
      await updateStatus(ctx, core);
      return;
    }
    delete extensionState.turnPolicy;
    if (core.mode() !== "plan" || sessionState(ctx).reviewInProgress) {
      await updateStatus(ctx, core);
      return;
    }
    if (core.ledger.getState<boolean>("planAutoReviewPending") !== true || !existsSync(core.config.planPath)) {
      await updateStatus(ctx, core);
      return;
    }
    await reviewPlan(ctx, core);
  });


  pi.registerCommand("atelier-open", {
    description: "Open a repository path at an optional line in the configured editor",
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify("Usage: /atelier-open PATH[:LINE]", "warning"); return; }
      const core = getCore(ctx);
      const editor = resolveEditorCommand(core.config, ctx.isProjectTrusted());
      const location = parseFileLocation(args, core.config.repositoryRoot);
      const result = await runInteractiveProcessWithPi(ctx, {
        command: editor.executable,
        args: editorArguments(editor, location),
        cwd: core.config.repositoryRoot,
        purpose: "Repository editor navigation",
      });
      if (result.exitCode !== 0) ctx.ui.notify(`Editor exited ${result.exitCode}${result.error ? `: ${result.error}` : ""}`, "error");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("atelier-files", {
    description: "Select a tracked repository file and open it in the configured editor",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const files = core.repository.listFiles();
      const selected = await ctx.ui.select("Open repository file", files);
      if (selected === undefined) return;
      const editor = resolveEditorCommand(core.config, ctx.isProjectTrusted());
      await runInteractiveProcessWithPi(ctx, {
        command: editor.executable,
        args: editorArguments(editor, { path: resolve(core.config.repositoryRoot, selected) }),
        cwd: core.config.repositoryRoot,
        purpose: "Repository file navigation",
      });
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("atelier-tree", {
    description: "Open Yazi when available or show a bounded repository tree",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      if (commandOnPath("yazi") && ctx.mode === "tui") {
        await runInteractiveProcessWithPi(ctx, {
          command: "yazi",
          args: [core.config.repositoryRoot],
          cwd: core.config.repositoryRoot,
          purpose: "Repository tree navigation",
        });
        await updateStatus(ctx, core);
        return;
      }
      ctx.ui.setWidget?.("atelier-tree", ["Atelier project tree", "", ...projectTree(core)], { placement: "aboveEditor" });
      ctx.ui.notify("Yazi is unavailable; showing the bounded Atelier tree above the editor. Run /atelier-tree again after installing Yazi.", "info");
    },
  });

  pi.registerCommand("review-diff", {
    description: "Display and record review of the exact current task diff",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const preview = core.previewFinalDiff();
      const approved = await confirmApprovalDialog(ctx, {
        title: "Review exact Atelier task diff",
        lines: [...preview.diff.trimEnd().split("\n"), "", `Changed paths: ${preview.changedPaths.join(", ")}`, `Diff SHA-256: ${preview.diffHash}`],
        approveLabel: "Record exact diff",
      });
      if (!approved) {
        ctx.ui.notify("Final diff review was not recorded.", "warning");
        return;
      }
      const review = core.reviewFinalDiff(preview.diffHash);
      ctx.ui.notify(`Reviewed ${review.changedPaths.length} path(s); diff ${review.diffHash}.`, "info");
      await updateStatus(ctx, core);
    },
  });

  pi.registerCommand("commit", {
    description: "Create the required local task commit or finalized Jujutsu change",
    handler: async (args, ctx) => {
      const message = args.trim();
      if (!message) { ctx.ui.notify("Usage: /commit MESSAGE", "warning"); return; }
      const core = getCore(ctx);
      try {
        const result = core.commitActiveTask(message);
        ctx.ui.notify(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}`, "info");
      } finally {
        await updateStatus(ctx, core);
      }
    },
  });

  pi.registerCommand("close", {
    description: "Close the active task after the authoritative completion predicate passes",
    handler: async (args, ctx) => {
      const reason = args.trim() || "Completed with current Atelier evidence.";
      const core = getCore(ctx);
      try {
        const result = await core.closeActiveTask(reason);
        ctx.ui.notify(`Closed ${result.task.id}; ${result.nextReady.length} approved-plan task(s) are ready.`, "info");
      } finally {
        await updateStatus(ctx, core);
      }
    },
  });

  pi.registerCommand("status", {
    description: "Show Atelier workflow, plan, task, and policy state",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      await showPhase(ctx, "reading status");
      try {
        const status = await core.status();
        appendAtelierReport(pi, ctx, "Atelier status", statusMarkdown(status), statusSummary(status));
        await updateStatus(ctx, core, status);
      } finally {
        clearPhase(ctx);
      }
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


  pi.registerCommand("plan-scope", {
    description: "Canonically update one task execution scope without editing embedded JSON",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      const [taskId, paths = "", validations = ""] = args.trim().split(/\s+/, 3);
      if (!taskId || !paths) {
        ctx.ui.notify("Usage: /plan-scope TASK_ID path1,path2 [validation1,validation2]", "warning");
        return;
      }
      const validationNames = validations.split(",").map((value) => value.trim()).filter(Boolean);
      const unknown = validationNames.filter((name) => core.validation.definition(name) === undefined);
      if (unknown.length > 0) {
        ctx.ui.notify(`Unknown validation(s): ${unknown.join(", ")}`, "error");
        return;
      }
      const execution = updatePlanTaskScopeFile(core.config.planPath, {
        taskId,
        execution: {
          writePaths: paths.split(",").map((value) => value.trim()).filter(Boolean),
          allowDependencyChanges: false,
          validations: validationNames,
          allowFullSuite: false,
          allowLocalChange: true,
        },
      });
      ctx.ui.notify(
        `Updated ${taskId} scope.\nWrites: ${execution.writePaths.join(", ")}\nValidations: ${execution.validations.join(", ") || "none"}\nDependency changes: not allowed\nFull suite: not allowed`,
        "info",
      );
      await updateStatus(ctx, core);
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
      const core = getCore(ctx);
      try {
        await approveAndReconcile(pi, ctx, core);
      } finally {
        await updateStatus(ctx, core);
      }
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
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      } finally {
        await updateStatus(ctx, core);
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
    description: "Pause active execution and abort the current turn without revoking task constraints",
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

  pi.registerCommand("atelier-resume-task", {
    description: "Resume a cancelled approved task after revalidating its plan, provider, workspace, and source baseline",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      const taskId = args.trim() || undefined;
      const confirmed = await ctx.ui.confirm("Resume cancelled task", `Resume ${taskId ?? "the most recently cancelled approved task"} after exact baseline validation?`);
      if (!confirmed) return;
      try {
        const transition = await core.execution.resumeCancelledTask(true, taskId);
        if (transition !== undefined) ctx.ui.notify(`Resumed task ${transition.task.id} with execution grant ${transition.executionGrant.id}. Existing changes and stale evidence were preserved.`, "info");
      } catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
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
        appendAtelierReport(pi, ctx, "Ready tasks", readyTasksMarkdown([]), "none ready");
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
        appendAtelierReport(pi, ctx, "Ready tasks", readyTasksMarkdown(ready), `${ready.length} ready`);
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

  const showWorkflowReport = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const core = getCore(ctx);
    const requested = args.trim();
    const full = requested === "--full" || requested === "full" || requested === "refresh";
    await showPhase(ctx, full ? "refreshing authoritative workflow state" : "reading durable workflow state");
    try {
      if (full) {
        const state = await core.buildWorkingState();
        appendAtelierReport(pi, ctx, "Atelier workflow · full", core.workingStateBuilder.toMarkdown(state), workflowSummary(state));
        await updateStatus(ctx, core);
        return;
      }
      const status = await core.status();
      appendAtelierReport(
        pi,
        ctx,
        "Atelier workflow",
        workflowStatusMarkdown(status),
        status.currentTaskId === undefined ? `${status.mode} · no active task` : `${status.mode} · task ${status.currentTaskId}`,
      );
      await updateStatus(ctx, core, status);
    } finally {
      clearPhase(ctx);
    }
  };

  pi.registerCommand("workflow", {
    description: "Show durable workflow state; use /workflow full or /workflow refresh for retrieval-backed diagnostics",
    handler: showWorkflowReport,
  });

  pi.registerCommand("state", {
    description: "Compatibility alias for /workflow",
    handler: showWorkflowReport,
  });

  registerCodeCommands(pi, {
    getCore,
    getFooterStatus: (ctx) => sessionState(ctx).footerStatus,
  });

  pi.registerCommand("performance", {
    description: "Show bounded interactive, subprocess, hashing, cache, and SQLite timing diagnostics",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      if (args.trim() === "clear") {
        core.clearPerformanceReport();
        ctx.ui.notify("Atelier performance samples cleared.", "info");
        return;
      }
      const report = core.performanceReport(100);
      appendAtelierReport(pi, ctx, "Atelier performance", performanceMarkdown(report), `${report.interactive.sampleCount + report.sqlite.sampleCount} sample(s)`);
    },
  });

  pi.registerCommand("changed", {
    description: "Show paths changed in the current repository",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      try {
        const paths = core.repository.changedPaths();
        const vcs = core.repository.snapshot().vcs;
        appendAtelierReport(pi, ctx, "Changed paths", changedMarkdown(paths, vcs), `${paths.length} path(s) · ${vcs}`);
      } finally {
        await updateStatus(ctx, core);
      }
    },
  });

  pi.registerCommand("validate", {
    description: "List or run configured Atelier validations",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      try {
        const name = args.trim();
        if (!name) {
          const manifest = core.validation.manifest();
          appendAtelierReport(pi, ctx, "Configured validations", validationListMarkdown(manifest.validations), `${Object.keys(manifest.validations).length} configured`);
          return;
        }
        if (name === "plan" || name === "focused") {
          if (name === "plan") {
            const selection = core.selectFocusedValidation();
            appendAtelierReport(pi, ctx, "Focused validation plan", focusedSelectionMarkdown(selection), `${selection.selected.length} selected`);
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
          appendAtelierReport(pi, ctx, "Validation results", validationResultsMarkdown(results), `${results.filter((item) => item.status === "passed").length}/${results.length} passed`);
          return;
        }
        const signal = contextSignal(ctx);
        const evidence = await core.runValidation(name, signal === undefined ? {} : { signal });
        appendAtelierReport(pi, ctx, "Validation result", validationResultsMarkdown([evidence]), `${evidence.name} · ${evidence.status}`);
      } finally {
        await updateStatus(ctx, core);
      }
    },
  });

  pi.registerCommand("evidence", {
    description: "Show current and stale validation evidence",
    handler: async (_args, ctx) => {
      const core = getCore(ctx);
      const items = core.validation.list({
        currentSnapshot: core.currentValidationSnapshot(),
        currentChangedPaths: core.currentSourceChangedPaths(),
      });
      appendAtelierReport(pi, ctx, "Validation evidence", evidenceMarkdown(items), `${items.filter((item) => !item.stale).length} current · ${items.filter((item) => item.stale).length} stale`);
      await updateStatus(ctx, core);
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
