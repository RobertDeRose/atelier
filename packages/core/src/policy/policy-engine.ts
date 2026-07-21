import { resolve } from "node:path";
import type {
  ActionKind,
  ActionRequest,
  Permission,
  PermissionGrant,
  PolicyDecision,
  WorkflowMode,
} from "../domain/types.ts";
import { newId } from "../util/ids.ts";

const ACTION_PERMISSION: Record<ActionKind, Permission> = {
  "read.repository": "repository.read",
  "write.file": "file.write",
  "write.multiple_files": "file.write",
  "dependency.modify": "dependency.modify",
  "repository.change.create": "repository.change.create",
  "repository.workspace.create": "repository.workspace.create",
  "repository.publish": "repository.publish",
  "task.create": "task.create",
  "task.update": "task.update",
  "task.link": "task.link",
  "task.close": "task.close",
  "validation.focused": "validation.focused",
  "validation.full_suite": "validation.full_suite",
  "command.execute": "command.execute",
  "command.long_running": "command.long_running",
  "network.access": "network.access",
  "capability.forge": "capability.forge",
  "capability.promote": "capability.promote",
};

export interface PolicyState {
  mode: WorkflowMode;
  repositoryRoot: string;
  planPath: string;
  grants: PermissionGrant[];
}

function pathWithin(path: string, allowedPath: string): boolean {
  const candidate = resolve(path);
  const allowed = resolve(allowedPath);
  return candidate === allowed || candidate.startsWith(`${allowed}/`);
}

function grantMatches(request: ActionRequest, grant: PermissionGrant, state: PolicyState, permission: Permission): boolean {
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.now()) return false;
  if (grant.permission !== permission) return false;
  if (grant.taskId !== undefined && grant.taskId !== request.taskId) return false;
  if (
    grant.repositoryId !== undefined &&
    grant.repositoryId !== request.repositorySnapshot?.repositoryId
  ) {
    return false;
  }
  if (grant.paths !== undefined && request.paths !== undefined) {
    if (!request.paths.every((path) => grant.paths?.some((allowed) => pathWithin(path, allowed)))) {
      return false;
    }
  }
  if (grant.commandPrefix !== undefined && request.command !== undefined) {
    if (!grant.commandPrefix.every((part, index) => request.command?.[index] === part)) {
      return false;
    }
  }
  if (grant.scope === "operation") {
    // Operation grants are consumed by the caller; matching is still valid here.
  }
  if (grant.scope === "task" && request.taskId === undefined) return false;
  if (grant.scope === "repository" && request.repositorySnapshot === undefined) return false;
  return true;
}

export class PolicyEngine {
  evaluate(request: ActionRequest, state: PolicyState): PolicyDecision {
    const requiredPermission = ACTION_PERMISSION[request.action];
    const matchedRules: string[] = [];
    const constraints: string[] = [];

    if (request.action === "read.repository") {
      matchedRules.push("read-only repository operations are allowed by default");
      return this.decision(request.action, "allow", matchedRules, [], constraints, "Read-only investigation is allowed.", requiredPermission);
    }

    if (state.mode === "plan" && request.action === "write.file") {
      const paths = request.paths ?? [];
      if (paths.length > 0 && paths.every((path) => resolve(path) === resolve(state.planPath))) {
        matchedRules.push("plan mode permits writes to the designated plan document");
        constraints.push(`writes are restricted to ${state.planPath}`);
        return this.decision(request.action, "allow", matchedRules, [], constraints, "Plan document write allowed.", requiredPermission);
      }
      matchedRules.push("plan mode denies source-code writes by default");
      return this.decision(
        request.action,
        "deny",
        matchedRules,
        [requiredPermission],
        constraints,
        "Plan mode only permits mutation of the designated plan document.",
        requiredPermission,
      );
    }

    if (state.mode === "plan" && [
      "dependency.modify",
      "repository.change.create",
      "repository.workspace.create",
      "repository.publish",
      "task.create",
      "task.update",
      "task.link",
      "task.close",
      "capability.forge",
      "capability.promote",
    ].includes(request.action)) {
      matchedRules.push(`plan mode blocks ${request.action}`);
      return this.decision(
        request.action,
        "deny",
        matchedRules,
        [requiredPermission],
        constraints,
        `${request.action} is not permitted during plan review.`,
        requiredPermission,
      );
    }

    const grant = state.grants.find((candidate) => grantMatches(request, candidate, state, requiredPermission));
    if (grant !== undefined) {
      matchedRules.push(`matched permission grant ${grant.id}`);
      if (grant.paths !== undefined) constraints.push(`paths constrained to ${grant.paths.join(", ")}`);
      return this.decision(request.action, "allow", matchedRules, [], constraints, `Allowed by ${grant.scope} grant.`, requiredPermission);
    }

    matchedRules.push(`no active ${requiredPermission} grant matched`);
    return this.decision(
      request.action,
      "require_approval",
      matchedRules,
      [requiredPermission],
      constraints,
      `Explicit approval is required for ${request.action}.`,
      requiredPermission,
    );
  }

  private decision(
    action: ActionKind,
    result: PolicyDecision["result"],
    matchedRules: string[],
    missingPermissions: Permission[],
    constraints: string[],
    reason: string,
    requiredPermission?: Permission,
  ): PolicyDecision {
    return {
      id: newId("policy"),
      result,
      action,
      ...(requiredPermission === undefined ? {} : { requiredPermission }),
      matchedRules,
      missingPermissions,
      constraints,
      reason,
    };
  }
}
