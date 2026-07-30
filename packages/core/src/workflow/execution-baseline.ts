import type {
  ApprovedTaskConstraint,
  ExecutionGrant,
  PlanTask,
  RepositorySnapshot,
} from "../domain/types.ts";
import type { RetrievalRevisionBinding } from "../repository/revision-binding.ts";
import {
  deriveTaskExecutionScope,
  type ValidationConstraintDescriptor,
} from "../planning/task-execution-scope.ts";
import { sha256 } from "../util/hash.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function createTaskConstraints(
  tasks: PlanTask[],
  repositoryRoot: string,
  validations: ValidationConstraintDescriptor[] = [],
  options: { requireValidation?: boolean; repositoryRoots?: Readonly<Record<string, string>>; primaryRepositoryId?: string } = {},
): ApprovedTaskConstraint[] {
  return tasks.map((task) => {
    const scope = deriveTaskExecutionScope(task, repositoryRoot, validations, options);
    if (scope.writePaths.length === 0) {
      throw new Error(
        `Task ${task.id} has no machine-resolvable write scope. Name repository-relative paths in the Scope section, preferably in backticks.`,
      );
    }
    if (scope.allowFullSuite && scope.fullValidations.length === 0) {
      throw new Error(`Task ${task.id} enables full-suite validation without naming a configured full validation.`);
    }
    return {
      planTaskId: task.id,
      writePaths: [...scope.writePaths],
      dependencyPaths: [...scope.dependencyPaths],
      allowDependencyChanges: scope.allowDependencyChanges,
      focusedValidations: [...scope.focusedValidations],
      fullValidations: [...scope.fullValidations],
      allowFullSuite: scope.allowFullSuite,
      allowLocalChange: scope.allowLocalChange,
      reason: `Reviewed execution constraints for ${task.id}.`,
    };
  });
}

export function constraintsForPlanTask(
  constraints: ApprovedTaskConstraint[],
  planTaskId: string,
): ApprovedTaskConstraint[] {
  return constraints.filter((constraint) => constraint.planTaskId === planTaskId);
}

export function taskConstraintDigest(constraints: ApprovedTaskConstraint[]): string {
  return sha256(JSON.stringify(canonical(constraints)));
}

export function executionConstraintsMatch(
  execution: ExecutionGrant,
  constraints: ApprovedTaskConstraint[],
): boolean {
  return execution.constraintDigest === taskConstraintDigest(constraintsForPlanTask(constraints, execution.planTaskId));
}

export function retrievalBindingDigest(bindings: RetrievalRevisionBinding[]): string {
  return sha256(JSON.stringify(canonical(bindings)));
}

export function sameRetrievalBindings(left: RetrievalRevisionBinding[], right: RetrievalRevisionBinding[]): boolean {
  return retrievalBindingDigest(left) === retrievalBindingDigest(right);
}

export function sourceBaselineMismatch(expected: RepositorySnapshot, actual: RepositorySnapshot): string | undefined {
  if (expected.repositoryId !== actual.repositoryId) return "repository identity changed";
  if (expected.workspaceId !== actual.workspaceId) return "workspace identity changed";
  if (expected.vcs !== actual.vcs) return "repository provider changed";
  if ((expected.sourceBaseCommit ?? expected.headCommit) !== (actual.sourceBaseCommit ?? actual.headCommit)) {
    return "source base changed";
  }
  if ((expected.sourceFingerprint ?? expected.dirtyFingerprint) !== (actual.sourceFingerprint ?? actual.dirtyFingerprint)) {
    return "source working state changed";
  }
  if (expected.indexSchemaVersion !== actual.indexSchemaVersion) return "repository index schema changed";
  return undefined;
}
