import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  classifyShellCommand,
  isDependencyPath,
  isAccessEntryWithin,
  type WorkflowActionRequest,
  type WorkflowDecision,
  type FilesystemEffect,
  resolveAccessEntryPath,
  resolveAccessPath,
  resolveSandboxBackend,
  sameAccessEntryPath,
  type RepositoryObservation,
} from "../../../packages/core/src/index.ts";

function toolReadPaths(event: any, ctx: ExtensionContext): string[] {
  const candidates = [event.input?.path, event.input?.directory, event.input?.cwd]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const paths = candidates.length === 0 ? [ctx.cwd] : candidates;
  return [...new Set(paths.map((path) => resolveAccessPath(path, "read", ctx.cwd)))];
}

function shellWritePaths(effects: readonly FilesystemEffect[]): string[] {
  return [...new Set(effects
    .filter((effect) => ["create", "mutate", "delete", "overwrite"].includes(effect.kind))
    .flatMap((effect) => effect.path === undefined ? [] : [effect.path]))];
}

export function requestForTool(
  event: any,
  ctx: ExtensionContext,
  core: AtelierCore,
  effects: readonly FilesystemEffect[] = [],
  observation?: RepositoryObservation,
): WorkflowActionRequest {
  const snapshot = observation?.snapshot ?? core.repository.peekObservation?.()?.snapshot ?? core.repository.snapshot();
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
    "atlr_state",
  ].includes(event.toolName)) {
    return {
      ...base,
      action: "read.repository",
      paths: event.toolName.startsWith("atlr_code_")
        ? [core.config.workspaceRoot]
        : toolReadPaths(event, ctx),
      rationale: `Pi ${event.toolName} tool performs a typed repository read.`,
    };
  }

  if (event.toolName === "atlr_validate") {
    const requested = event.input?.action;
    if (requested === "plan") {
      return {
        ...base,
        action: "read.repository",
        paths: [core.config.workspaceRoot],
        rationale: "Atelier validation planning selects checks without executing repository code.",
      };
    }
    const configuredName = typeof event.input?.name === "string" ? event.input.name : undefined;
    const category = configuredName === undefined
      ? "focused"
      : core.validation.manifest().validations[configuredName]?.category === "full" ? "full" : "focused";
    const validationNames = configuredName === undefined
      ? core.approvedValidationNames(category)
      : [configuredName];
    return {
      ...base,
      action: category === "full" ? "validation.full_suite" : "validation.focused",
      risk: "routine",
      ...(configuredName === undefined ? {} : { validationName: configuredName }),
      validationNames,
      rationale: "Atelier typed validation executes only validations named by the reviewed task contract.",
    };
  }


  if (event.toolName === "atlr_commit") {
    return {
      ...base,
      action: "repository.change.create",
      risk: "routine",
      paths: core.approvedTaskPaths(),
      rationale: "Atelier typed local-change creation is confined to the reviewed task paths.",
    };
  }

  if (event.toolName === "atlr_task_close") {
    return {
      ...base,
      action: "task.close",
      risk: "routine",
      rationale: "Atelier typed task closure is guarded by the authoritative completion predicate.",
    };
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = typeof event.input?.path === "string"
      ? resolveAccessEntryPath(event.input.path, "write", ctx.cwd)
      : undefined;
    const dependency = path !== undefined
      && isDependencyPath(path);
    return {
      ...base,
      action: dependency ? "dependency.modify" : "write.file",
      risk: "routine",
      ...(path === undefined ? {} : { paths: [path] }),
      rationale: dependency
        ? `Pi ${event.toolName} tool modifies a dependency manifest through a typed path.`
        : `Pi ${event.toolName} tool modifies a file through a typed path.`,
    };
  }

  if (event.toolName === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const classification = classifyShellCommand(command);
    const readOnly = classification.action === "read.repository"
      && classification.mutating === false
      && classification.risk === "routine"
      && effects.length > 0
      && effects.every((effect) => effect.kind === "read");
    const sandbox = resolveSandboxBackend(core.config.sandboxBackend);
    const writePaths = shellWritePaths(effects);
    return {
      ...base,
      action: readOnly ? "read.repository" : "command.execute",
      risk: classification.risk,
      command: [command],
      ...(readOnly
        ? { paths: effects.flatMap((effect) => effect.path === undefined ? [] : [effect.path]) }
        : writePaths.length > 0 ? { paths: writePaths } : {}),
      rationale: readOnly
        ? `${classification.rationale.join("; ")} Both shell-analysis layers classify the command as read-only. ${sandbox.available ? `Execution uses ${sandbox.detail}.` : "No OS sandbox is needed for this bounded read-only operation."}`
        : `${classification.rationale.join("; ")} Persistent effects remain governed by workspace recoverability. ${sandbox.available ? `Execution uses ${sandbox.detail}.` : "Unsandboxed execution requires an explicit one-operation approval."}`,
    };
  }

  return {
    ...base,
    action: "command.execute",
    risk: "unknown",
    rationale: `Custom tool ${String(event.toolName)} is not declared read-only to Atelier.`,
  };
}


function consequenceMessage(decision: ReturnType<AtelierCore["evaluateWorkspaceEffects"]>): string {
  const groups = new Map<string, string[]>();
  for (const effect of decision.effects.filter((item) => item.decision === "ask" || item.decision === "deny")) {
    const key = effect.reason;
    const paths = groups.get(key) ?? [];
    const path = effect.entryPath ?? effect.resolvedPath;
    if (path !== undefined) paths.push(path);
    groups.set(key, paths);
  }
  return [...groups.entries()].map(([reason, paths]) =>
    paths.length === 0 ? reason : `${reason}\n${paths.slice(0, 5).map((path) => `  ${path}`).join("\n")}${paths.length > 5 ? `\n  … and ${paths.length - 5} more` : ""}`
  ).join("\n\n");
}

async function showAuthorizationPhase(ctx: ExtensionContext, message: string): Promise<void> {
  ctx.ui.setWorkingMessage?.(`Atelier: ${message}…`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface WorkspaceEffectsAuthorization {
  response?: { block?: boolean; reason?: string };
  checkpointId?: string;
  approvedOnce?: boolean;
  observation: RepositoryObservation;
}

export function repositoryObservationPaths(
  effects: readonly { path?: string }[],
  core: AtelierCore,
): string[] {
  return effects.flatMap((effect) =>
    effect.path !== undefined && isAccessEntryWithin(effect.path, core.config.repositoryRoot, "write")
      ? [effect.path]
      : []);
}

export async function recordBlockedWorkspaceConsequence(
  effects: readonly FilesystemEffect[],
  ctx: ExtensionContext,
  core: AtelierCore,
): Promise<RepositoryObservation> {
  const observation = await core.observeRepository({
    paths: repositoryObservationPaths(effects, core),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    operation: "permission",
  });
  await recordWorkspacePolicyDecision(effects, ctx, core, { observation });
  return observation;
}

export async function recordWorkspacePolicyDecision(
  effects: readonly FilesystemEffect[],
  ctx: ExtensionContext,
  core: AtelierCore,
  options: { observation?: RepositoryObservation } = {},
): Promise<{ decision: ReturnType<AtelierCore["evaluateWorkspaceEffects"]>; observation: RepositoryObservation }> {
  await showAuthorizationPhase(ctx, "evaluating operation effects");
  const evaluated = await core.evaluateWorkspaceEffectsAsync(effects, {
    ...(options.observation === undefined ? {} : { observation: options.observation }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    operation: "permission",
  });
  core.ledger.append({
    kind: "workspace_policy.decision",
    actor: "agent",
    repositorySnapshot: evaluated.observation.snapshot,
    payload: evaluated.decision,
  });
  return evaluated;
}

export async function authorizeWorkspaceEffects(
  effects: readonly FilesystemEffect[],
  ctx: ExtensionContext,
  core: AtelierCore,
  options: {
    toolCallId?: string;
    sessionId?: string;
    requireExplicitApproval?: boolean;
    approvalWarning?: string;
    observation?: RepositoryObservation;
  } = {},
): Promise<WorkspaceEffectsAuthorization> {
  const { decision, observation } = await recordWorkspacePolicyDecision(effects, ctx, core, {
    ...(options.observation === undefined ? {} : { observation: options.observation }),
  });

  const confirmOnce = async (reason: string): Promise<WorkspaceEffectsAuthorization> => {
    const detail = [reason, options.approvalWarning].filter(Boolean).join("\n\n");
    if (!ctx.hasUI) {
      return {
        observation,
        response: { block: true, reason: `${detail} Interactive approval is unavailable in ${ctx.mode} mode.` },
      };
    }
    ctx.ui.setWorkingMessage?.();
    const approved = await ctx.ui.confirm("Atelier approval required", `${detail}\n\nAllow this concrete operation once?`);
    core.ledger.append({
      kind: approved ? "workspace_policy.approval_granted" : "workspace_policy.approval_denied",
      actor: "user",
      repositorySnapshot: observation.snapshot,
      payload: { decision, ...(options.approvalWarning === undefined ? {} : { warning: options.approvalWarning }) },
    });
    return approved
      ? { observation, approvedOnce: true }
      : { observation, response: { block: true, reason: "The user denied this Atelier operation." } };
  };

  if (decision.result === "allow") {
    return options.requireExplicitApproval === true
      ? confirmOnce(decision.reason || "This operation requires one-time approval.")
      : { observation };
  }

  if (decision.result === "checkpoint_then_allow") {
    // Explicit approval must happen before an expensive checkpoint is copied and
    // verified. The prompt tells the user exactly what will happen next.
    if (options.requireExplicitApproval === true) {
      const approval = await confirmOnce(
        `${decision.reason || "This operation is recoverable through an Atelier checkpoint."}\n\n`
        + "If approved, Atelier will create and verify an exact recovery checkpoint before execution.",
      );
      if (approval.response !== undefined) return approval;
    }

    try {
      await showAuthorizationPhase(ctx, "creating recovery checkpoint");
      const checkpoint = core.checkpointWorkspaceEffects(decision, {
        ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        repositorySnapshot: observation.snapshot,
      });
      return {
        observation,
        checkpointId: checkpoint.id,
        ...(options.requireExplicitApproval === true ? { approvedOnce: true } : {}),
      };
    } catch (error) {
      const reason = `Atelier could not create an exact recovery checkpoint: ${error instanceof Error ? error.message : String(error)}`;
      if (!ctx.hasUI) {
        return {
          observation,
          response: { block: true, reason: `${reason} Interactive approval is unavailable in ${ctx.mode} mode.` },
        };
      }
      ctx.ui.setWorkingMessage?.();
      const detail = [reason, options.approvalWarning].filter(Boolean).join("\n\n");
      const approved = await ctx.ui.confirm("Atelier recovery unavailable", `${detail}\n\nContinue once without a checkpoint?`);
      core.ledger.append({
        kind: approved ? "workspace_policy.approval_granted" : "workspace_policy.approval_denied",
        actor: "user",
        repositorySnapshot: observation.snapshot,
        payload: { decision, checkpointUnavailable: true, reason },
      });
      return approved
        ? { observation, approvedOnce: true }
        : { observation, response: { block: true, reason: "The user declined an unrecoverable operation." } };
    }
  }

  const reason = consequenceMessage(decision) || decision.reason;
  if (decision.result === "deny") return { observation, response: { block: true, reason } };
  return confirmOnce(reason);
}

export async function authorizeShellEffects(
  effects: readonly FilesystemEffect[],
  ctx: ExtensionContext,
  core: AtelierCore,
  options: {
    toolCallId?: string;
    sessionId?: string;
    observation?: RepositoryObservation;
    allowUnsandboxedReadOnly?: boolean;
  } = {},
): Promise<WorkspaceEffectsAuthorization & { allowUnsandboxed: boolean }> {
  const sandbox = resolveSandboxBackend(core.config.sandboxBackend);
  const coreOnly = core.config.securityMode === "core-only";
  const requireUnsandboxedApproval = !coreOnly && !sandbox.available && options.allowUnsandboxedReadOnly !== true;
  const authorization = await authorizeWorkspaceEffects(effects, ctx, core, {
    ...options,
    ...(requireUnsandboxedApproval ? {
      requireExplicitApproval: true,
      approvalWarning: `${sandbox.detail} This command will run without OS-level confinement if approved.`,
    } : {}),
  });
  return {
    ...authorization,
    allowUnsandboxed: coreOnly || (!sandbox.available
      && (authorization.approvedOnce === true || options.allowUnsandboxedReadOnly === true)),
  };
}

interface ToolAuthorization {
  decision: WorkflowDecision;
  response?: { block?: boolean; reason?: string };
}

export function isDesignatedPlanWrite(request: WorkflowActionRequest, core: AtelierCore): boolean {
  return core.mode() === "plan"
    && request.action === "write.file"
    && (request.paths?.length ?? 0) > 0
    && request.paths?.every((path) => sameAccessEntryPath(path, core.config.planPath, "write")) === true;
}

export async function authorizeTool(
  request: WorkflowActionRequest,
  _ctx: ExtensionContext,
  core: AtelierCore,
): Promise<ToolAuthorization> {
  const decision = core.evaluateWorkflow(request);
  if (decision.result === "allow") return { decision };
  core.ledger.append({
    kind: "workflow.authorization_blocked",
    actor: request.actor,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
    payload: { decisionId: decision.id, action: request.action, reason: decision.reason },
  });
  return { decision, response: { block: true, reason: decision.reason } };
}
