import type { CodeProviderIdentity } from "../domain/code-identity.ts";
import type { RepositorySnapshot } from "./snapshot.ts";
import { sha256 } from "../util/hash.ts";

export interface RepositoryRevisionBinding {
  repositoryId: string;
  snapshotRepositoryId: string;
  workspaceId: string;
  vcs: "jj" | "git" | "none";
  headCommit: string;
  sourceBaseCommit: string;
  sourceFingerprint: string;
  changeId?: string;
  operationId?: string;
  dirtyGeneration: number;
  dirtyFingerprint: string;
  indexSchemaVersion: number;
}

export interface RetrievalRevisionBinding {
  workspaceId: string;
  provider: CodeProviderIdentity;
  indexRevision?: string;
  repositories: RepositoryRevisionBinding[];
}

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

export function repositoryRevisionBinding(repositoryId: string, snapshot: RepositorySnapshot): RepositoryRevisionBinding {
  return {
    repositoryId,
    snapshotRepositoryId: snapshot.repositoryId,
    workspaceId: snapshot.workspaceId,
    vcs: snapshot.vcs,
    headCommit: snapshot.headCommit,
    sourceBaseCommit: snapshot.sourceBaseCommit ?? snapshot.headCommit,
    sourceFingerprint: snapshot.sourceFingerprint ?? snapshot.dirtyFingerprint,
    ...(snapshot.changeId === undefined ? {} : { changeId: snapshot.changeId }),
    ...(snapshot.operationId === undefined ? {} : { operationId: snapshot.operationId }),
    dirtyGeneration: snapshot.dirtyGeneration,
    dirtyFingerprint: snapshot.dirtyFingerprint,
    indexSchemaVersion: snapshot.indexSchemaVersion,
  };
}

export function repositoryBindingDigest(bindings: RepositoryRevisionBinding[]): string {
  return sha256(JSON.stringify(canonical(bindings.map((binding) => ({
    repositoryId: binding.repositoryId,
    snapshotRepositoryId: binding.snapshotRepositoryId,
    workspaceId: binding.workspaceId,
    vcs: binding.vcs,
    sourceBaseCommit: binding.sourceBaseCommit,
    sourceFingerprint: binding.sourceFingerprint,
    indexSchemaVersion: binding.indexSchemaVersion,
  })))));
}

export function sameRepositoryBindings(left: RepositoryRevisionBinding[], right: RepositoryRevisionBinding[]): boolean {
  return repositoryBindingDigest(left) === repositoryBindingDigest(right);
}

export function repositoryBindingMismatch(
  expected: RepositoryRevisionBinding[],
  actual: RepositoryRevisionBinding[],
): string | undefined {
  const expectedById = new Map(expected.map((binding) => [binding.repositoryId, binding]));
  const actualById = new Map(actual.map((binding) => [binding.repositoryId, binding]));
  if (expectedById.size !== actualById.size) return "approved workspace repository set changed";
  for (const [repositoryId, left] of expectedById) {
    const right = actualById.get(repositoryId);
    if (right === undefined) return `approved workspace repository disappeared: ${repositoryId}`;
    if (repositoryBindingDigest([left]) !== repositoryBindingDigest([right])) {
      return `workspace repository revision changed: ${repositoryId}`;
    }
  }
  return undefined;
}
