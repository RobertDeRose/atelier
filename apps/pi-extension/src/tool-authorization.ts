import { relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmApprovalDialog } from "./approval-dialog.ts";
import {
  AtelierCore,
  classifyShellCommand,
  isDependencyPath,
  type ActionRequest,
  type PolicyDecision,
  type FilesystemEffect,
} from "../../../packages/core/src/index.ts";

function toolReadPaths(event: any, ctx: ExtensionContext): string[] {
  const candidates = [event.input?.path, event.input?.directory, event.input?.cwd]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const paths = candidates.length === 0 ? [ctx.cwd] : candidates;
  return [...new Set(paths.map((path) => resolve(ctx.cwd, path)))];
}

export function requestForTool(event: any, ctx: ExtensionContext, core: AtelierCore): ActionRequest {
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
      boundary: "typed",
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
        boundary: "typed",
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
      boundary: "typed",
      rationale: "Atelier typed validation executes only validations named by the reviewed task contract.",
    };
  }


  if (event.toolName === "atlr_commit") {
    return {
      ...base,
      action: "repository.change.create",
      risk: "routine",
      paths: core.approvedTaskPaths(),
      boundary: "typed",
      rationale: "Atelier typed local-change creation is confined to the reviewed task paths.",
    };
  }

  if (event.toolName === "atlr_task_close") {
    return {
      ...base,
      action: "task.close",
      risk: "routine",
      boundary: "typed",
      rationale: "Atelier typed task closure is guarded by the authoritative completion predicate.",
    };
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = typeof event.input?.path === "string"
      ? resolve(ctx.cwd, event.input.path)
      : undefined;
    const dependency = path !== undefined
      && isDependencyPath(relative(core.config.repositoryRoot, path));
    return {
      ...base,
      action: dependency ? "dependency.modify" : "write.file",
      risk: "routine",
      ...(path === undefined ? {} : { paths: [path] }),
      boundary: "typed",
      rationale: dependency
        ? `Pi ${event.toolName} tool modifies a dependency manifest through a typed path.`
        : `Pi ${event.toolName} tool modifies a file through a typed path.`,
    };
  }

  if (event.toolName === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const classification = classifyShellCommand(command);
    return {
      ...base,
      // Classification supplies diagnostics only. Generic shell is always an
      // executable operation so a parser miss cannot bypass execution grants
      // or durable tool evidence by presenting the command as a repository read.
      action: "command.execute",
      risk: classification.risk,
      command: [command],
      boundary: "unconfined",
      rationale: `${classification.rationale.join("; ")} Generic shell is always authorized as unconfined command execution.`,
    };
  }

  return {
    ...base,
    action: "command.execute",
    risk: "unknown",
    boundary: "unconfined",
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
): Promise<{ response?: { block?: boolean; reason?: string }; checkpointId?: string; approvedOnce?: boolean }> {
  const decision = core.evaluateWorkspaceEffects(effects);
  core.ledger.append({ kind: "workspace_policy.decision", actor: "agent", repositorySnapshot: core.repository.snapshot(), payload: decision });
  if (decision.result === "allow") return {};
  if (decision.result === "checkpoint_then_allow") {
    try {
      const checkpoint = core.checkpointWorkspaceEffects(decision);
      return { checkpointId: checkpoint.id };
    } catch (error) {
      const reason = `Atelier could not create an exact recovery checkpoint: ${error instanceof Error ? error.message : String(error)}`;
      if (!ctx.hasUI) return { response: { block: true, reason: `${reason} Interactive approval is unavailable in ${ctx.mode} mode.` } };
      const approved = await ctx.ui.confirm("Atelier recovery unavailable", `${reason}\n\nContinue once without a checkpoint?`);
      return approved ? {} : { response: { block: true, reason: "The user declined an unrecoverable operation." } };
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
  decision: PolicyDecision;
  permissionGrantId?: string;
  response?: { block?: boolean; reason?: string };
}

export function isDesignatedPlanWrite(request: ActionRequest, core: AtelierCore): boolean {
  return core.mode() === "plan"
    && request.action === "write.file"
    && (request.paths?.length ?? 0) > 0
    && request.paths?.every((path) => resolve(path) === resolve(core.config.planPath)) === true;
}

function matchedPermissionGrantId(decision: PolicyDecision): string | undefined {
  return decision.matchedRules.find((rule) => rule.startsWith("matched permission grant "))
    ?.slice("matched permission grant ".length);
}

export async function authorizeTool(
  request: ActionRequest,
  ctx: ExtensionContext,
  core: AtelierCore,
  options: { workspaceApproved?: boolean } = {},
): Promise<ToolAuthorization> {
  const decision = core.evaluate(request);
  if (decision.result === "allow") {
    const permissionGrantId = matchedPermissionGrantId(decision);
    return { decision, ...(permissionGrantId === undefined ? {} : { permissionGrantId }) };
  }
  if (decision.result === "require_approval" && options.workspaceApproved === true) {
    const allowed: PolicyDecision = {
      ...decision,
      id: `${decision.id}-workspace-approved`,
      result: "allow",
      matchedRules: [...decision.matchedRules, "matched concrete workspace-policy approval"],
      missingPermissions: [],
      reason: "Allowed by the concrete workspace-policy approval.",
    };
    core.ledger.append({
      kind: "policy.decision",
      actor: "user",
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: allowed,
    });
    return { decision: allowed };
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

  const allowed: PolicyDecision = {
    ...decision,
    id: `${decision.id}-approved`,
    result: "allow",
    matchedRules: [...decision.matchedRules, "matched concrete workspace-policy approval"],
    missingPermissions: [],
    reason: "Allowed by one-time concrete user approval.",
  };
  core.ledger.append({
    kind: "policy.approval_consumed",
    actor: "user",
    ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
    payload: { decisionId: decision.id, action: request.action },
  });
  core.ledger.append({
    kind: "policy.decision",
    actor: "user",
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
    payload: allowed,
  });
  return { decision: allowed };
}

