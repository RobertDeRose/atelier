import type {
  ExecutionCapability,
  ExecutionGrant,
  PermissionGrant,
  PlanTask,
  RepositorySnapshot,
} from "../domain/types.ts";
import type { RetrievalRevisionBinding } from "../repository/revision-binding.ts";
import {
  deriveTaskExecutionScope,
  type ValidationCapabilityDescriptor,
} from "../planning/task-execution-scope.ts";
import { sha256 } from "../util/hash.ts";
import { newId, nowIso } from "../util/ids.ts";

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

export function createExecutionCapabilities(
  tasks: PlanTask[],
  repositoryRoot: string,
  validations: ValidationCapabilityDescriptor[] = [],
  options: { requireValidation?: boolean; repositoryRoots?: Readonly<Record<string, string>>; primaryRepositoryId?: string } = {},
): ExecutionCapability[] {
  const capabilities: ExecutionCapability[] = [];
  for (const task of tasks) {
    const scope = deriveTaskExecutionScope(task, repositoryRoot, validations, options);
    if (scope.writePaths.length === 0) {
      throw new Error(
        `Task ${task.id} has no machine-resolvable write scope. Name repository-relative paths in the Scope section, preferably in backticks.`,
      );
    }
    if (scope.fileWritePaths.length > 0) {
      capabilities.push({
        planTaskId: task.id,
        permission: "file.write",
        paths: scope.fileWritePaths,
        reason: `Typed writes for ${task.id} are limited to the reviewed non-dependency paths.`,
      });
    }
    if (scope.dependencyPaths.length > 0) {
      capabilities.push({
        planTaskId: task.id,
        permission: "dependency.modify",
        paths: scope.dependencyPaths,
        reason: `Dependency changes are explicitly included in reviewed task ${task.id}.`,
      });
    }
    if (scope.allowLocalChange) {
      capabilities.push({
        planTaskId: task.id,
        permission: "repository.change.create",
        paths: scope.writePaths,
        reason: `Create one local change containing only the reviewed source paths for ${task.id}.`,
      });
    }
    capabilities.push({
      planTaskId: task.id,
      permission: "task.close",
      reason: `Close ${task.id} only after the authoritative completion predicate passes.`,
    });
    if (scope.focusedValidations.length > 0) {
      capabilities.push({
        planTaskId: task.id,
        permission: "validation.focused",
        validationNames: scope.focusedValidations,
        reason: `Run only the focused validations named by reviewed task ${task.id}.`,
      });
    }
    if (scope.allowFullSuite) {
      if (scope.fullValidations.length === 0) {
        throw new Error(`Task ${task.id} enables full-suite validation without naming a configured full validation.`);
      }
      capabilities.push({
        planTaskId: task.id,
        permission: "validation.full_suite",
        validationNames: scope.fullValidations,
        reason: `Run only the full-suite validations named by reviewed task ${task.id}.`,
      });
    }
  }
  return capabilities;
}

export function capabilitiesForPlanTask(
  capabilities: ExecutionCapability[],
  planTaskId: string,
): ExecutionCapability[] {
  return capabilities.filter((capability) => capability.planTaskId === planTaskId);
}

export function executionCapabilityDigest(capabilities: ExecutionCapability[]): string {
  return sha256(JSON.stringify(canonical(capabilities)));
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

export function permissionGrantsMatchCapabilities(
  grants: PermissionGrant[],
  execution: ExecutionGrant,
  capabilities: ExecutionCapability[],
): boolean {
  const expected = capabilitiesForPlanTask(capabilities, execution.planTaskId);
  const active = grants.filter((grant) => grant.executionGrantId === execution.id && grant.revokedAt === undefined);
  const projected = active.map((grant): ExecutionCapability => ({
    planTaskId: execution.planTaskId,
    permission: grant.permission,
    ...(grant.paths === undefined ? {} : { paths: [...grant.paths] }),
    ...(grant.validationNames === undefined ? {} : { validationNames: [...grant.validationNames] }),
    reason: grant.reason,
  }));
  return executionCapabilityDigest(projected) === executionCapabilityDigest(expected);
}

export function permissionGrantsForExecution(
  execution: ExecutionGrant,
  capabilities: ExecutionCapability[],
): PermissionGrant[] {
  const timestamp = nowIso();
  return capabilitiesForPlanTask(capabilities, execution.planTaskId).map((capability): PermissionGrant => ({
    id: newId("grant"),
    executionGrantId: execution.id,
    permission: capability.permission,
    scope: "task",
    actor: "user",
    taskId: execution.taskId,
    repositoryId: execution.repositoryId,
    ...(capability.paths === undefined ? {} : { paths: [...capability.paths] }),
    ...(capability.validationNames === undefined ? {} : { validationNames: [...capability.validationNames] }),
    reason: capability.reason,
    createdAt: timestamp,
  }));
}
