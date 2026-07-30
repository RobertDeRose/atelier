import { relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  classifyShellCommand,
  isDependencyPath,
  type WorkflowActionRequest,
  type WorkflowDecision,
  type FilesystemEffect,
  resolveAccessPath,
  sameAccessPath,
} from "../../../packages/core/src/index.ts";

function toolReadPaths(event: any, ctx: ExtensionContext): string[] {
  const candidates = [event.input?.path, event.input?.directory, event.input?.cwd]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const paths = candidates.length === 0 ? [ctx.cwd] : candidates;
  return [...new Set(paths.map((path) => resolveAccessPath(resolve(ctx.cwd, path), "read")))];
}

export function requestForTool(event: any, ctx: ExtensionContext, core: AtelierCore, effects: readonly FilesystemEffect[] = []): WorkflowActionRequest {
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
    "atlr_state",
  ].includes(event.toolName)) {
    return {
      ...base,
      action: "read.repository",
      paths: event.toolName.startsWith("atlr_code_")
        ? core.codeWorkspace().roots
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
        paths: core.codeWorkspace().roots,
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
      ? resolveAccessPath(resolve(ctx.cwd, event.input.path), "write")
      : undefined;
    const dependency = path !== undefined
      && isDependencyPath(relative(core.config.repositoryRoot, path));
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
    const readOnly = effects.length > 0 && effects.every((effect) => effect.kind === "read");
    return {
      ...base,
      action: readOnly ? "read.repository" : "command.execute",
      risk: classification.risk,
      command: [command],
      ...(readOnly ? { paths: effects.flatMap((effect) => effect.path === undefined ? [] : [effect.path]) } : {}),
      rationale: readOnly
        ? `${classification.rationale.join("; ")} The parsed shell effects are read-only and remain OS-sandboxed.`
        : `${classification.rationale.join("; ")} Persistent effects remain governed by workspace recoverability and the OS sandbox.`,
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
    if (effect.resolvedPath !== undefined) paths.push(effect.resolvedPath);
    groups.set(key, paths);
  }
  return [...groups.entries()].map(([reason, paths]) =>
    paths.length === 0 ? reason : `${reason}\n${paths.slice(0, 5).map((path) => `  ${path}`).join("\n")}${paths.length > 5 ? `\n  … and ${paths.length - 5} more` : ""}`
  ).join("\n\n");
}

export async function authorizeWorkspaceEffects(
  effects: readonly FilesystemEffect[],
  ctx: ExtensionContext,
  core: AtelierCore,
  options: { toolCallId?: string; sessionId?: string } = {},
): Promise<{ response?: { block?: boolean; reason?: string }; checkpointId?: string; approvedOnce?: boolean }> {
  const decision = core.evaluateWorkspaceEffects(effects);
  core.ledger.append({ kind: "workspace_policy.decision", actor: "agent", repositorySnapshot: core.repository.snapshot(), payload: decision });
  if (decision.result === "allow") return {};
  if (decision.result === "checkpoint_then_allow") {
    try {
      const checkpoint = core.checkpointWorkspaceEffects(decision, options);
      return { checkpointId: checkpoint.id };
    } catch (error) {
      const reason = `Atelier could not create an exact recovery checkpoint: ${error instanceof Error ? error.message : String(error)}`;
      if (!ctx.hasUI) return { response: { block: true, reason: `${reason} Interactive approval is unavailable in ${ctx.mode} mode.` } };
      const approved = await ctx.ui.confirm("Atelier recovery unavailable", `${reason}\n\nContinue once without a checkpoint?`);
      return approved ? { approvedOnce: true } : { response: { block: true, reason: "The user declined an unrecoverable operation." } };
    }
  }
  const reason = consequenceMessage(decision) || decision.reason;
  if (decision.result === "deny") return { response: { block: true, reason } };
  if (!ctx.hasUI) return { response: { block: true, reason: `${reason} Interactive approval is unavailable in ${ctx.mode} mode.` } };
  const approved = await ctx.ui.confirm("Atelier approval required", `${reason}\n\nAllow this concrete operation once?`);
  core.ledger.append({ kind: approved ? "workspace_policy.approval_granted" : "workspace_policy.approval_denied", actor: "user", repositorySnapshot: core.repository.snapshot(), payload: { decision } });
  return approved ? { approvedOnce: true } : { response: { block: true, reason: "The user denied this Atelier operation." } };
}
interface ToolAuthorization {
  decision: WorkflowDecision;
  response?: { block?: boolean; reason?: string };
}

export function isDesignatedPlanWrite(request: WorkflowActionRequest, core: AtelierCore): boolean {
  return core.mode() === "plan"
    && request.action === "write.file"
    && (request.paths?.length ?? 0) > 0
    && request.paths?.every((path) => sameAccessPath(path, core.config.planPath, "write")) === true;
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
