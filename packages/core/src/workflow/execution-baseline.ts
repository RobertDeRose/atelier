import type {
  ExecutionCapability,
  ExecutionGrant,
  PermissionGrant,
  RepositorySnapshot,
} from "../domain/types.ts";
import type { RetrievalRevisionBinding } from "../repository/revision-binding.ts";
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

export function createExecutionCapabilities(repositoryRoot: string): ExecutionCapability[] {
  return [
    { permission: "file.write", paths: [repositoryRoot], reason: "Typed task file writes inside the approved repository." },
    { permission: "dependency.modify", paths: [repositoryRoot], reason: "Typed dependency changes inside the approved repository." },
    { permission: "repository.change.create", paths: [repositoryRoot], reason: "Create one local change or commit for the approved task." },
    { permission: "task.update", reason: "Update the active task through the configured task provider." },
    { permission: "task.link", reason: "Maintain approved task relationships through the configured task provider." },
    { permission: "task.close", reason: "Close the active task only after the completion predicate passes." },
    { permission: "validation.focused", reason: "Run declared focused validations." },
    { permission: "validation.full_suite", reason: "Run declared full-suite validations." },
  ];
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
  if (expected.headCommit !== actual.headCommit) return "source head changed";
  if (expected.changeId !== actual.changeId) return "source change identity changed";
  if (expected.dirtyFingerprint !== actual.dirtyFingerprint) return "source working state changed";
  if (expected.indexSchemaVersion !== actual.indexSchemaVersion) return "repository index schema changed";
  return undefined;
}


export function permissionGrantsMatchCapabilities(
  grants: PermissionGrant[],
  execution: ExecutionGrant,
  capabilities: ExecutionCapability[],
): boolean {
  const active = grants.filter((grant) => grant.executionGrantId === execution.id && grant.revokedAt === undefined);
  const projected = active.map((grant): ExecutionCapability => ({
    permission: grant.permission,
    ...(grant.paths === undefined ? {} : { paths: [...grant.paths] }),
    reason: grant.reason,
  }));
  return executionCapabilityDigest(projected) === executionCapabilityDigest(capabilities);
}

export function permissionGrantsForExecution(
  execution: ExecutionGrant,
  capabilities: ExecutionCapability[],
): PermissionGrant[] {
  const timestamp = nowIso();
  return capabilities.map((capability): PermissionGrant => ({
    id: newId("grant"),
    executionGrantId: execution.id,
    permission: capability.permission,
    scope: "task",
    actor: "user",
    taskId: execution.taskId,
    repositoryId: execution.repositoryId,
    ...(capability.paths === undefined ? {} : { paths: [...capability.paths] }),
    reason: capability.reason,
    createdAt: timestamp,
  }));
}
