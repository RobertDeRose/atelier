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

function codeToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const message = errorMessage(error);
  return {
    content: [{ type: "text", text: `Atelier code intelligence failed: ${message}` }],
    details: { error: message },
  };
}

let activeCore: AtelierCore | undefined;
let activeRoot: string | undefined;
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
  activeCore?.close();
  activeCore = AtelierCore.open(root);
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
    ctx.ui.setStatus(STATUS_KEY, `Atelier ${status.mode} · ${approved ? "approved" : "review"} · ${task} · ${index}`);
  } catch (error) {
    ctx.ui.setStatus(STATUS_KEY, "Atelier unavailable");
    ctx.ui.notify(errorMessage(error), "error");
  }
}

function requestForTool(event: any, ctx: ExtensionContext, core: AtelierCore): ActionRequest {
  const snapshot = core.repository.snapshot();
  const base = {
    actor: "agent" as const,
    repositorySnapshot: snapshot,
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

async function authorizeTool(
  request: ActionRequest,
  ctx: ExtensionContext,
  core: AtelierCore,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const decision = core.evaluate(request);
  if (decision.result === "allow") return undefined;
  if (decision.result === "deny") {
    core.ledger.append({
      kind: "policy.blocked",
      actor: "agent",
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: { decisionId: decision.id, action: request.action, reason: decision.reason },
    });
    return { block: true, reason: decision.reason };
  }

  if (!ctx.hasUI || decision.requiredPermission === undefined) {
    return {
      block: true,
      reason: `${decision.reason} Interactive approval is unavailable in ${ctx.mode} mode.`,
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
    return { block: true, reason: "The user denied this Atelier operation." };
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
  return allowed.result === "allow"
    ? undefined
    : { block: true, reason: allowed.reason };
}

async function runEditorWithPi(
  ctx: ExtensionContext,
  core: AtelierCore,
  editor: ManualEditEditor,
): Promise<{ exitCode: number; error?: string; signal?: string; editor: ManualEditEditor }> {
  if (ctx.mode !== "tui") {
    throw new Error("The configured external editor requires Pi TUI mode.");
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
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  core: AtelierCore,
  options: { continueAgentReview: boolean },
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

    if (errors.length > 0) {
      ctx.ui.notify(`Plan review found ${errors.length} blocking validation error(s).`, "warning");
    } else {
      ctx.ui.notify(`Reviewed ${parsed.tasks.length} plan task(s).`, "info");
    }

    if (options.continueAgentReview) {
      core.ledger.setState("planAutoReviewBaselineHash", review.afterHash);
      core.ledger.setState("planAutoReviewPending", true);
      pi.sendUserMessage(
        `[Atelier] The user reviewed the plan directly in ${core.config.planPath}. ` +
          "Treat that file as authoritative. Re-read it, check task identity, dependencies, scope, validation, and completion criteria. " +
          "Do not modify source code or task-provider state. Update only the plan if corrections are required; otherwise report that it is ready for approval and stop.",
      );
    }
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
    "Begin repository discovery with the active atlr_code_search tool and use atlr_code_symbols for identifier lookup. " +
    "Read exact returned files afterward. Do not use broad rg, grep, find, fd, tree, or ls discovery unless Atelier reports unavailable, degraded, failed, or empty provider evidence. " +
    "Use stable task IDs, explicit dependencies, scope, validation steps, and observable completion criteria. " +
    "Do not ask the user to describe textual plan edits after the draft; Atelier will open the plan in their configured editor. " +
    `When the draft is complete, stop.\n\nObjective: ${objective || "Create an implementation plan for the current request."}`;
}

async function approveAndReconcile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  core: AtelierCore,
): Promise<void> {
  await ctx.waitForIdle();
  const plan = core.parsePlan();
  const errors = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.length > 0) {
    ctx.ui.notify(`Plan has ${errors.length} blocking validation error(s).`, "error");
    return;
  }
  if (core.ledger.getState<string>("reviewedPlanHash") !== plan.hash) {
    ctx.ui.notify("The current plan revision must be reviewed in the configured editor before approval.", "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Approve Atelier plan",
    `Approve revision ${plan.hash.slice(0, 12)} with ${plan.tasks.length} task(s) and enter act mode?`,
  );
  if (!confirmed) return;

  core.approvePlan();
  core.ledger.setState("planAutoReviewPending", false);
  let providerReady = false;
  let providerStatus = await core.taskProvider.status();
  if (providerStatus.available && !providerStatus.initialized) {
    const initialize = await ctx.ui.confirm(
      "Initialize task provider",
      `Initialize ${providerStatus.provider} in this repository so the approved plan can become executable task state?`,
    );
    if (initialize) {
      await core.taskProvider.initialize({ quiet: true });
      providerStatus = await core.taskProvider.status();
    }
  }
  providerReady = providerStatus.available && providerStatus.initialized;

  if (providerReady) {
    const preview = await core.reconcilePlan(false);
    if (preview.conflicts.length > 0) {
      ctx.ui.notify(`Task reconciliation has ${preview.conflicts.length} conflict(s).`, "error");
      return;
    }
    if (preview.operations.length > 0) {
      const apply = await ctx.ui.confirm(
        "Apply task reconciliation",
        `Apply ${preview.operations.length} create, update, or dependency operation(s) to ${core.taskProvider.name}?`,
      );
      if (!apply) {
        ctx.ui.notify("Plan approved, but task reconciliation was not applied.", "warning");
        return;
      }
      const applied = await core.reconcilePlan(true);
      if (!applied.applied || applied.conflicts.length > 0) {
        ctx.ui.notify("Task reconciliation did not complete.", "error");
        return;
      }
    }
  } else {
    ctx.ui.notify(
      `Plan approved without persistent task state because ${providerStatus.provider} is unavailable or not initialized.`,
      "warning",
    );
  }

  core.setMode("act");
  await updateStatus(ctx, core);
  pi.sendUserMessage(
    `[Atelier] Plan revision ${plan.hash} is approved. ` +
      "Enter implementation mode using the current task selected from durable task state when available. " +
      "Inspect current source before acting, stay within the approved task scope, record findings in task state, and allow Atelier to gate every mutation independently.",
  );
}

export default function atelierExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "atlr_code_status",
    label: "Atelier Code Status",
    description: "Inspect the configured Atelier code-intelligence provider, capabilities, and index state without modifying the repository.",
    promptSnippet: "Inspect Atelier code-provider health before falling back to raw repository scanning",
    promptGuidelines: [
      "Use atlr_code_status when atlr_code_search fails or reports unavailable, unhealthy, stale, or degraded provider state.",
    ],
    parameters: objectSchema({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const core = coreFor(ctx);
        const workspace = core.codeWorkspace();
        const status = await core.code.status(undefined, workspace);
        const text = [
          `Provider: ${status.identity.name}${status.identity.version ? ` ${status.identity.version}` : ""}`,
          `Available: ${status.available}`,
          `Healthy: ${status.healthy}`,
          `Index: ${status.indexState}`,
          `Capabilities: ${status.capabilities.join(", ") || "none"}`,
          ...(status.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
          ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { status, workspaceId: workspace.id } };
      } catch (error) {
        rawDiscoveryFallbackAllowed = true;
        return codeToolError(error);
      }
    },
  });

  pi.registerTool({
    name: "atlr_code_search",
    label: "Atelier Code Search",
    description: "Search the configured Atelier workspace through the accepted code-intelligence provider with bounded results and provenance.",
    promptSnippet: "Search repository implementation, tests, and documentation through Atelier code intelligence",
    promptGuidelines: [
      "You MUST use atlr_code_search as the first repository-discovery step before broad grep, find, rg, ls, or directory-wide reads.",
      "Use built-in read after atlr_code_search identifies an exact file or range; use raw grep/find only when Atelier explicitly reports unavailable, degraded, or no usable evidence.",
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
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        const status = await core.code.status(undefined, workspace);
        rawDiscoveryFallbackAllowed = results.length === 0 || status.available === false || status.healthy === false ||
          status.degraded === true || results.some((hit) => hit.provenance.degraded === true);
        const text = results.length === 0
          ? `No Atelier code matches for: ${input.query}\nProvider: ${status.identity.name} · index ${status.indexState}`
          : [
              `Atelier code search: ${input.query}`,
              `Provider: ${status.identity.name} · index ${status.indexState} · ${results.length} result(s)`,
              "",
              ...results.map(codeHitText),
            ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            query: input.query,
            provider: status.identity,
            indexState: status.indexState,
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
            })),
          },
        };
      } catch (error) {
        rawDiscoveryFallbackAllowed = true;
        return codeToolError(error);
      }
    },
  });

  pi.registerTool({
    name: "atlr_code_symbols",
    label: "Atelier Symbol Search",
    description: "Find symbol definitions and references through the configured Atelier code-intelligence provider.",
    promptSnippet: "Find code symbols through Atelier instead of broad text scanning",
    promptGuidelines: [
      "Use atlr_code_symbols for function, class, type, command, and module discovery before raw symbol grep.",
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
        rawDiscoveryFallbackAllowed = results.length === 0;
        const text = results.length === 0
          ? `No Atelier symbols matched: ${input.query}`
          : results.map(codeHitText).join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: {
            query: input.query,
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
            })),
          },
        };
      } catch (error) {
        rawDiscoveryFallbackAllowed = true;
        return codeToolError(error);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    resetDiscoveryRouting();
    const core = coreFor(ctx);
    ensureCodeToolsActive(pi, core);
    stopIndexStatusUpdates?.();
    stopIndexStatusUpdates = core.code.onIndexStatus(() => {
      void updateStatus(ctx, core);
    });
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
          ? "Atelier code intelligence returned usable evidence. Read the exact returned paths instead of broad grep/find scanning."
          : "Plan mode requires provider-first discovery. Call atlr_code_search or atlr_code_symbols before broad grep/find/rg/ls scanning.",
      };
    }
    const request = requestForTool(event, ctx, core);
    const result = await authorizeTool(request, ctx, core);
    await updateStatus(ctx, core);
    return result;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    resetDiscoveryRouting();
    const core = coreFor(ctx);
    ensureCodeToolsActive(pi, core);
    const state = await core.buildWorkingState();
    const activeContext = core.workingStateBuilder.toMarkdown(state);
    const retrievalInstruction = core.config.codeProvider === "disabled"
      ? "Atelier code intelligence is disabled; use exact built-in read/grep/find operations as needed."
      : "Provider-first retrieval is enforced: you MUST call atlr_code_search before broad repository discovery and atlr_code_symbols before broad identifier scans. Read exact returned files afterward. Broad grep/find/rg/ls is allowed only after Atelier reports unavailable, degraded, or no usable evidence.";
    const modeInstruction = state.mode === "plan"
      ? `Only ${core.config.planPath} may be modified. Task-provider and source mutations are prohibited until approval. Read-only repository investigation never requires approval. ${retrievalInstruction}`
      : state.mode === "investigate"
        ? "Investigate only. Any mutation requires a distinct Atelier approval."
        : "Implement only the selected task and approved scope. Routine changes, validations, task updates, and local commits inside the active repository are approved by default. Ask only before destructive operations, external side effects, publication, or work outside the repository. Do not report implementation complete with uncommitted changes: run the appropriate validation and create a local Jujutsu change or Git commit before stopping.";
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Atelier enforced working state\n\n${modeInstruction}\n\n${activeContext}`,
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const core = coreFor(ctx);
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
    const baseline = core.ledger.getState<string>("planAutoReviewBaselineHash");
    const current = hashFile(core.config.planPath);
    if (baseline === current) {
      core.ledger.setState("planAutoReviewPending", false);
      await updateStatus(ctx, core);
      return;
    }
    await reviewPlan(pi, ctx, core, { continueAgentReview: true });
  });

  pi.registerCommand("status", {
    description: "Show Atelier workflow, plan, task, and policy state",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const status = await core.status();
      ctx.ui.notify(
        `Mode: ${status.mode}\nPlan: ${status.currentPlanHash === status.approvedPlanHash ? "approved" : "not approved"}\n` +
          `Task: ${status.currentTaskId ?? "none"}\nProvider: ${status.taskProvider.provider} (${status.taskProvider.initialized ? "ready" : "not initialized"})`,
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
      await reviewPlan(pi, ctx, core, { continueAgentReview: true });
    },
  });

  pi.registerCommand("approve", {
    description: "Approve the reviewed plan, reconcile Beads, and enter act mode",
    handler: async (_args, ctx) => {
      await approveAndReconcile(pi, ctx, coreFor(ctx));
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
      ctx.ui.notify([
        `Provider: ${status.identity.name}`,
        `Available: ${status.available}`,
        `Healthy: ${status.healthy}`,
        `Index: ${status.indexState}`,
        `Capabilities: ${status.capabilities.join(", ") || "none"}`,
        ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
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
      const results = await core.code.search({ workspace: core.codeWorkspace(), text: query, limit: 10 });
      const message = results.length === 0
        ? "No code matches."
        : results.map((item) => `${item.repositoryName}:${item.path}${item.startLine === undefined ? "" : `:${item.startLine}`}\n${item.preview ?? ""} [${item.provenance.provider.name}/${item.provenance.indexState}]`).join("\n\n");
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
      const results = await core.code.symbols({ workspace: core.codeWorkspace(), text: query, limit: 20 });
      const message = results.length === 0
        ? "No symbols matched."
        : results.map((item) => `${item.symbol ?? "symbol"} ${item.repositoryName}:${item.path}${item.startLine === undefined ? "" : `:${item.startLine}`}`).join("\n");
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
      const snapshot = core.repository.snapshot();
      if (name === "plan" || name === "focused") {
        const changedPaths = core.repository.changedPaths();
        const plan = core.validation.planFocused(changedPaths, []);
        if (name === "plan") {
          ctx.ui.notify(plan.length === 0 ? "No focused validations matched." : plan.map((item) => `${item.name}: ${item.reason}`).join("\n"), "info");
          return;
        }
        const results = plan.map((item) => core.validation.run(item.name, snapshot));
        ctx.ui.notify(results.length === 0 ? "No focused validations matched." : results.map((item) => `${item.name}: ${item.status} (${item.durationMs} ms)`).join("\n"), results.some((item) => item.status !== "passed") ? "error" : "info");
        return;
      }
      const evidence = core.validation.run(name, snapshot);
      core.ledger.append({ kind: "validation.completed", actor: "user", repositorySnapshot: snapshot, payload: { id: evidence.id, name, status: evidence.status, durationMs: evidence.durationMs } });
      ctx.ui.notify(`${name}: ${evidence.status} (${evidence.durationMs} ms)`, evidence.status === "passed" ? "info" : "error");
    },
  });

  pi.registerCommand("evidence", {
    description: "Show current and stale validation evidence",
    handler: async (_args, ctx) => {
      const core = coreFor(ctx);
      const items = core.validation.list({ currentSnapshot: core.repository.snapshot() });
      const message = items.length === 0
        ? "No validation evidence."
        : items.map((item) => `${item.name}: ${item.status} (${item.stale ? "stale" : "current"})`).join("\n");
      ctx.ui.notify(message, "info");
    },
  });

}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
