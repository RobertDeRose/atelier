import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  classifyShellCommand,
  type ActionRequest,
  type PolicyDecision,
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

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = typeof event.input?.path === "string"
      ? resolve(ctx.cwd, event.input.path)
      : undefined;
    return {
      ...base,
      action: "write.file",
      risk: "routine",
      ...(path === undefined ? {} : { paths: [path] }),
      boundary: "typed",
      rationale: `Pi ${event.toolName} tool modifies a file through a typed path.`,
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

