import type {
  ActionKind,
  ActionRequest,
  ExecutionGrant,
  Permission,
  TaskClosureReadiness,
  PermissionGrant,
  PolicyDecision,
  WorkflowMode,
} from "../domain/types.ts";
import { isPathWithin, sameAccessPath, type PathAccess } from "../security/path-boundary.ts";
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

const ROUTINE_ACT_ACTIONS = new Set<ActionKind>([
  "write.file",
  "write.multiple_files",
  "dependency.modify",
  "repository.change.create",
  "task.create",
  "task.update",
  "task.link",
  "task.close",
  "validation.focused",
  "validation.full_suite",
]);

export interface PolicyState {
  mode: WorkflowMode;
  repositoryRoot: string;
  repositoryReadRoots?: string[];
  planPath: string;
  grants: PermissionGrant[];
  executionGrant?: ExecutionGrant;
  executionPaused?: boolean;
  taskClosure?: TaskClosureReadiness;
}

function accessFor(permission: Permission): PathAccess {
  return permission === "repository.read" ? "read" : "write";
}

function executionMatches(request: ActionRequest, grant: ExecutionGrant | undefined): boolean {
  if (grant === undefined || grant.status !== "active") return false;
  if (request.taskId === undefined || request.taskId !== grant.taskId) return false;
  if (request.repositorySnapshot === undefined) return false;
  return request.repositorySnapshot.workspaceId === grant.workspaceId
    && request.repositorySnapshot.repositoryId === grant.repositoryId;
}

function grantMatches(request: ActionRequest, grant: PermissionGrant, permission: Permission): boolean {
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.now()) return false;
  if (grant.permission !== permission) return false;
  if (request.boundary === "unconfined" && grant.scope !== "operation") return false;
  if (grant.taskId !== undefined && grant.taskId !== request.taskId) return false;
  if (grant.repositoryId !== undefined && grant.repositoryId !== request.repositorySnapshot?.repositoryId) return false;
  if (grant.paths !== undefined) {
    if (request.paths === undefined || request.paths.length === 0) return false;
    const access = accessFor(permission);
    if (!request.paths.every((path) => grant.paths?.some((allowed) => isPathWithin(path, allowed, access)))) return false;
  }
  if (grant.validationNames !== undefined) {
    const requested = request.validationNames ?? (request.validationName === undefined ? [] : [request.validationName]);
    if (requested.length === 0 || !requested.every((name) => grant.validationNames?.includes(name))) return false;
  }
  if (grant.scope === "task" && request.taskId === undefined) return false;
  if (grant.scope === "repository" && request.repositorySnapshot === undefined) return false;
  return true;
}

function pathsWithinRepository(request: ActionRequest, repositoryRoot: string): boolean {
  if (request.paths === undefined || request.paths.length === 0) return false;
  const access: PathAccess = request.action === "read.repository" ? "read" : "write";
  return request.paths.every((path) => isPathWithin(path, repositoryRoot, access));
}

function readPathsWithinApprovedRoots(request: ActionRequest, state: PolicyState): boolean {
  if (request.paths === undefined || request.paths.length === 0) return false;
  const roots = state.repositoryReadRoots?.length ? state.repositoryReadRoots : [state.repositoryRoot];
  return request.paths.every((path) => roots.some((root) => isPathWithin(path, root, "read")));
}

export class PolicyEngine {
  evaluate(request: ActionRequest, state: PolicyState): PolicyDecision {
    const requiredPermission = ACTION_PERMISSION[request.action];
    const matchedRules: string[] = [];
    const constraints: string[] = [];

    if (request.action === "read.repository" && request.boundary !== "unconfined" && readPathsWithinApprovedRoots(request, state)) {
      const roots = state.repositoryReadRoots?.length ? state.repositoryReadRoots : [state.repositoryRoot];
      matchedRules.push("typed repository reads are allowed inside session workspace real-path boundaries");
      constraints.push(`resolved paths must remain within ${roots.join(", ")}`);
      return this.decision(request.action, "allow", matchedRules, [], constraints, "Repository-scoped typed read allowed.", requiredPermission);
    }

    if (state.executionPaused === true && request.actor === "agent" && request.action !== "read.repository") {
      matchedRules.push("the active execution is paused and agent mutations are disabled until explicit resume");
      return this.decision(
        request.action,
        "deny",
        matchedRules,
        [requiredPermission],
        constraints,
        "Execution is paused. Resume it explicitly before agent mutation.",
        requiredPermission,
      );
    }

    if (state.mode === "plan" && request.action === "write.file") {
      const paths = request.paths ?? [];
      if (request.boundary !== "unconfined" && paths.length > 0
        && paths.every((path) => sameAccessPath(path, state.planPath, "write"))) {
        matchedRules.push("plan mode permits typed writes to the designated plan document");
        constraints.push(`writes are restricted to ${state.planPath}`);
        return this.decision(request.action, "allow", matchedRules, [], constraints, "Plan document write allowed.", requiredPermission);
      }
      matchedRules.push("plan mode denies source and unconfined writes");
      return this.decision(
        request.action,
        "deny",
        matchedRules,
        [requiredPermission],
        constraints,
        "Plan mode only permits typed mutation of the designated plan document.",
        requiredPermission,
      );
    }

    if (state.mode === "plan" && [
      "write.multiple_files",
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

    const executionRequired = state.mode === "act" && request.actor === "agent" && request.action !== "read.repository";
    if (executionRequired && !executionMatches(request, state.executionGrant)) {
      matchedRules.push("act-mode agent mutation requires a valid task-scoped execution grant");
      return this.decision(
        request.action,
        "require_approval",
        matchedRules,
        [requiredPermission],
        constraints,
        "A valid execution grant for the request task and workspace is required.",
        requiredPermission,
      );
    }

    if (request.action === "task.close" && state.taskClosure?.ready !== true) {
      matchedRules.push("task closure requires the authoritative completion predicate");
      return this.decision(
        request.action,
        "deny",
        matchedRules,
        [requiredPermission],
        constraints,
        state.taskClosure?.reason ?? "Task closure evidence is unavailable.",
        requiredPermission,
      );
    }

    const grant = state.grants.find((candidate) =>
      (!executionRequired || candidate.executionGrantId === state.executionGrant?.id)
      && grantMatches(request, candidate, requiredPermission));
    if (grant !== undefined) {
      matchedRules.push(`matched permission grant ${grant.id}`);
      if (grant.paths !== undefined) constraints.push(`real paths constrained to ${grant.paths.join(", ")}`);
      if (grant.validationNames !== undefined) constraints.push(`validations constrained to ${grant.validationNames.join(", ")}`);
      if (request.boundary === "unconfined") constraints.push("unconfined shell permission is single-operation only");
      return this.decision(request.action, "allow", matchedRules, [], constraints, `Allowed by ${grant.scope} grant.`, requiredPermission);
    }

    if (request.boundary === "unconfined") {
      matchedRules.push("generic shell execution is unconfined and never inherits task or repository grants");
      return this.decision(
        request.action,
        "require_approval",
        matchedRules,
        [requiredPermission],
        constraints,
        "Unconfined shell execution requires a distinct single-operation approval.",
        requiredPermission,
      );
    }

    if (state.mode === "act" && request.actor !== "agent" && request.risk === "routine" && ROUTINE_ACT_ACTIONS.has(request.action)) {
      if (request.paths !== undefined && request.paths.length > 0 && !pathsWithinRepository(request, state.repositoryRoot)) {
        matchedRules.push("routine act-mode mutations are limited to the real active repository boundary");
        constraints.push(`resolved paths must remain within ${state.repositoryRoot}`);
      } else {
        matchedRules.push("an explicit user action permits routine typed work in act mode");
        constraints.push(`operation is constrained to ${state.repositoryRoot}`);
        return this.decision(
          request.action,
          "allow",
          matchedRules,
          [],
          constraints,
          "Explicit routine user operation allowed.",
          requiredPermission,
        );
      }
    }

    if (request.risk === "destructive") matchedRules.push("destructive operations require explicit approval");
    else if (request.risk === "external") matchedRules.push("external side effects and publication require explicit approval");
    else if (request.risk === "unknown") matchedRules.push("operations with unknown effects require explicit approval");

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
