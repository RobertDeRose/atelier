import type {
  ApprovedTaskConstraint,
  ExecutionGrant,
  TaskClosureReadiness,
  WorkflowActionRequest,
  WorkflowDecision,
  WorkflowMode,
} from "../domain/types.ts";
import { isAccessEntryWithin, relativeAccessPath, sameAccessEntryPath } from "../security/path-boundary.ts";
import { isDependencyPath, isSourcePath } from "../repository/source-path.ts";
import { newId } from "../util/ids.ts";

export interface WorkflowGuardState {
  mode: WorkflowMode;
  workspaceRoot: string;
  repositoryRoot?: string;
  planPath: string;
  executionGrant?: ExecutionGrant;
  executionPaused?: boolean;
  taskConstraints: ApprovedTaskConstraint[];
  taskClosure?: TaskClosureReadiness;
}

function selectedConstraint(state: WorkflowGuardState): ApprovedTaskConstraint | undefined {
  const grant = state.executionGrant;
  if (grant === undefined) return undefined;
  return state.taskConstraints.find((constraint) => constraint.planTaskId === grant.planTaskId);
}

function allowedPath(path: string, approved: readonly string[]): boolean {
  return approved.some((candidate) =>
    sameAccessEntryPath(path, candidate, "write") || isAccessEntryWithin(path, candidate, "write"));
}

function repositoryRelativePath(repositoryRoot: string, path: string): string | undefined {
  const relationship = relativeAccessPath(path, repositoryRoot, "write", repositoryRoot);
  return relationship === "" ? "." : relationship;
}

function hasRepositoryRootScope(constraint: ApprovedTaskConstraint, repositoryRoot: string | undefined): boolean {
  return repositoryRoot !== undefined && constraint.writePaths.some((path) => sameAccessEntryPath(path, repositoryRoot, "write"));
}

function allowedSourcePath(
  path: string,
  constraint: ApprovedTaskConstraint,
  repositoryRoot: string | undefined,
): boolean {
  if (!allowedPath(path, constraint.writePaths)) return false;
  if (!hasRepositoryRootScope(constraint, repositoryRoot) || repositoryRoot === undefined) return true;
  const relativePath = repositoryRelativePath(repositoryRoot, path);
  if (relativePath === undefined || !isSourcePath(relativePath)) return false;
  return constraint.allowDependencyChanges || !isDependencyPath(relativePath);
}

function allowedDependencyPath(
  path: string,
  constraint: ApprovedTaskConstraint,
  repositoryRoot: string | undefined,
): boolean {
  const relativePath = repositoryRoot === undefined ? path : repositoryRelativePath(repositoryRoot, path);
  if (relativePath === undefined || relativePath === "." || !isDependencyPath(relativePath)) return false;
  const broadScope = hasRepositoryRootScope(constraint, repositoryRoot);
  return allowedPath(path, constraint.dependencyPaths)
    || (broadScope && constraint.allowDependencyChanges && allowedPath(path, constraint.writePaths));
}

function decision(request: WorkflowActionRequest, result: "allow" | "deny", reason: string, matchedRules: string[] = []): WorkflowDecision {
  return { id: newId("workflow-decision"), result, action: request.action, matchedRules, constraints: [], reason };
}

/**
 * Enforces reviewed workflow/task constraints only. Filesystem containment,
 * secret handling, privilege escalation, and recoverability are deliberately
 * owned by WorkspacePolicyEvaluator and RecoveryManager.
 */
export class WorkflowGuard {
  evaluate(request: WorkflowActionRequest, state: WorkflowGuardState): WorkflowDecision {
    if (request.action === "read.repository") {
      return decision(request, "allow", "Read effects are governed by the session workspace policy.", ["workflow reads are not task constraints"]);
    }

    if (state.mode === "plan") {
      const paths = request.paths ?? [];
      if ((request.action === "write.file" || request.action === "write.multiple_files")
        && paths.length > 0 && paths.every((path) => sameAccessEntryPath(path, state.planPath, "write"))) {
        return decision(request, "allow", "Plan mode permits mutation only of the designated plan document.", ["plan document mutation"]);
      }
      return decision(request, "deny", "Plan mode permits only the designated plan document to change.");
    }

    if (state.mode === "investigate") {
      return decision(request, "deny", "Investigate mode is read-only. Enter a reviewed task execution before mutating state.");
    }

    const grant = state.executionGrant;
    const constraint = selectedConstraint(state);
    if (grant === undefined || constraint === undefined || request.taskId !== grant.taskId) {
      return decision(request, "deny", "Agent mutation requires the active reviewed task execution.");
    }
    if (state.executionPaused) return decision(request, "deny", "The active task is paused.");

    switch (request.action) {
      case "write.file":
      case "write.multiple_files": {
        const paths = request.paths ?? [];
        if (paths.length === 0 || !paths.every((path) => allowedSourcePath(path, constraint, state.repositoryRoot))) {
          return decision(request, "deny", "The operation exceeds the reviewed task path constraints or targets excluded metadata/dependency paths.");
        }
        return decision(request, "allow", "The operation stays within the reviewed task paths.", ["reviewed task path constraint"]);
      }
      case "dependency.modify": {
        if (!constraint.allowDependencyChanges) return decision(request, "deny", "Dependency changes were excluded by the reviewed task.");
        const paths = request.paths ?? [];
        if (paths.length === 0 || !paths.every((path) => allowedDependencyPath(path, constraint, state.repositoryRoot))) {
          return decision(request, "deny", "The dependency operation exceeds the reviewed dependency paths.");
        }
        return decision(request, "allow", "Dependency changes are explicitly reviewed for these paths.", ["reviewed dependency constraint"]);
      }
      case "validation.focused": {
        const names = request.validationName === undefined
          ? request.validationNames ?? []
          : [request.validationName];
        if (names.length === 0 || !names.every((name) => constraint.focusedValidations.includes(name))) {
          return decision(request, "deny", "The focused validation was not named by the reviewed task.");
        }
        return decision(request, "allow", "The focused validation is named by the reviewed task.", ["reviewed validation constraint"]);
      }
      case "validation.full_suite": {
        const name = request.validationName;
        if (!constraint.allowFullSuite || name === undefined || !constraint.fullValidations.includes(name)) {
          return decision(request, "deny", "Full-suite validation was not included by the reviewed task.");
        }
        return decision(request, "allow", "The full-suite validation is explicitly reviewed.", ["reviewed full-suite constraint"]);
      }
      case "repository.change.create": {
        if (!constraint.allowLocalChange) return decision(request, "deny", "A local change was not included by the reviewed task.");
        const paths = request.paths ?? [];
        if (paths.length === 0 || !paths.every((path) => allowedSourcePath(path, constraint, state.repositoryRoot))) {
          return decision(request, "deny", "The local change includes paths outside the reviewed task or excluded metadata/dependency paths.");
        }
        return decision(request, "allow", "The local change is limited to reviewed task paths.", ["reviewed local-change constraint"]);
      }
      case "task.close": {
        if (state.taskClosure?.ready !== true) return decision(request, "deny", state.taskClosure?.reason ?? "Task closure evidence is incomplete.");
        return decision(request, "allow", "The authoritative closure predicate is satisfied.", ["authoritative task closure"]);
      }
      case "task.update":
      case "task.link":
        return decision(request, "allow", "The operation affects only the active reviewed task graph.", ["active task workflow constraint"]);
      case "command.execute":
      case "command.long_running":
        // Filesystem effects are still checked independently. Unknown shell
        // effects are never authorized merely because a task is active.
        return decision(request, "allow", "Shell execution remains subject to workspace containment and recoverability.", ["workspace policy remains authoritative"]);
      default:
        return decision(request, request.actor === "user" ? "allow" : "deny",
          request.actor === "user" ? "Explicit user workflow operation is allowed subject to workspace policy." : "The operation is outside the reviewed task workflow.");
    }
  }
}
