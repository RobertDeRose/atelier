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
  readPlanDocument,
  resolveEditorCommand,
  type ActionRequest,
  type Permission,
} from "../../../packages/core/src/index.ts";

const STATUS_KEY = "atlr";
const EMPTY_COMPONENT = {
  render: (_width: number): string[] => [],
  invalidate: (): void => {},
};

let activeCore: AtelierCore | undefined;
let activeRoot: string | undefined;
let reviewInProgress = false;

function coreFor(ctx: ExtensionContext): AtelierCore {
  const root = resolve(ctx.cwd);
  if (activeCore !== undefined && activeRoot === root) return activeCore;
  activeCore?.close();
  activeCore = AtelierCore.open(root);
  activeRoot = root;
  return activeCore;
}

async function updateStatus(ctx: ExtensionContext, core = coreFor(ctx)): Promise<void> {
  try {
    const status = await core.status();
    const approved = status.currentPlanHash !== undefined && status.currentPlanHash === status.approvedPlanHash;
    const task = status.currentTaskId === undefined ? "no task" : status.currentTaskId;
    ctx.ui.setStatus(STATUS_KEY, `Atelier ${status.mode} · ${approved ? "approved" : "review"} · ${task}`);
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

  if (["read", "grep", "find", "ls"].includes(event.toolName)) {
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
      command: [command],
      rationale: classification.rationale.join("; "),
    };
  }

  return {
    ...base,
    action: "command.execute",
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
): Promise<{ exitCode: number; error?: string; editor: string }> {
  if (ctx.mode !== "tui") {
    throw new Error("The configured external editor requires Pi TUI mode.");
  }
  const editor = resolveEditorCommand(core.config, ctx.isProjectTrusted());
  const result = await ctx.ui.custom<{ exitCode: number; error?: string }>((tui, _theme, _keybindings, done) => {
    tui.stop();
    let exitCode = 1;
    let error: string | undefined;
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
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      tui.start();
      tui.requestRender(true);
    }
    done({ exitCode, ...(error === undefined ? {} : { error }) });
    return EMPTY_COMPONENT;
  });
  return {
    ...result,
    editor: [editor.executable, ...editor.args].join(" "),
  };
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
  try {
    ensurePlanDocument(core.config.planPath);
    const beforeText = readPlanDocument(core.config.planPath);
    const beforeHash = hashFile(core.config.planPath);
    core.ledger.append({
      kind: "manual_edit.started",
      actor: "user",
      repositorySnapshot: core.repository.snapshot(),
      payload: { path: core.config.planPath, beforeHash, purpose: "plan_review" },
    });

    const result = await runEditorWithPi(ctx, core);
    if (result.exitCode !== 0) {
      throw new Error(`Editor exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`);
    }
    if (!existsSync(core.config.planPath)) {
      throw new Error(`The plan document was removed: ${core.config.planPath}`);
    }

    const afterText = readPlanDocument(core.config.planPath);
    const review = core.recordPlanReview(beforeText, afterText);
    const parsed = core.parsePlan();
    const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    core.ledger.append({
      kind: "plan.reviewed",
      actor: "user",
      repositorySnapshot: core.repository.snapshot(),
      payload: {
        path: core.config.planPath,
        editor: result.editor,
        beforeHash: review.beforeHash,
        afterHash: review.afterHash,
        changed: review.changed,
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
  pi.on("session_start", async (_event, ctx) => {
    const core = coreFor(ctx);
    await updateStatus(ctx, core);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeCore?.close();
    activeCore = undefined;
    activeRoot = undefined;
    reviewInProgress = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const core = coreFor(ctx);
    const request = requestForTool(event, ctx, core);
    const result = await authorizeTool(request, ctx, core);
    await updateStatus(ctx, core);
    return result;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const core = coreFor(ctx);
    const state = await core.buildWorkingState();
    const activeContext = core.workingStateBuilder.toMarkdown(state);
    const modeInstruction = state.mode === "plan"
      ? `Only ${core.config.planPath} may be modified. Task-provider and source mutations are prohibited until approval.`
      : state.mode === "investigate"
        ? "Investigate only. Any mutation requires a distinct Atelier approval."
        : "Implement only the selected task and approved scope. Every mutation remains independently permission-gated.";
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
      await ctx.waitForIdle();
      const core = coreFor(ctx);
      ensurePlanDocument(core.config.planPath);
      core.setMode("plan");
      const baseline = hashFile(core.config.planPath);
      core.ledger.setState("planAutoReviewBaselineHash", baseline);
      core.ledger.setState("planAutoReviewPending", true);
      core.ledger.append({
        kind: "plan.requested",
        actor: "user",
        repositorySnapshot: core.repository.snapshot(),
        payload: { objective: args.trim(), path: core.config.planPath, baseline },
      });
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
    description: "Ensure the current Atelier workspace is indexed by the configured code provider",
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
