import type { RepositorySnapshot } from "../repository/snapshot.ts";
import { repositoryRevisionBinding } from "../repository/revision-binding.ts";
import { sha256 } from "../util/hash.ts";
import type {
  CachedQueryCoverage,
  CanonicalQueryFilters,
  CanonicalRetrievalQuery,
  EvidenceIdentity,
  RepositoryRevisionBinding,
  RetrievalEvidenceKind,
  RetrievalOperation,
  RetrievalReuseDecision,
  RetrievalRevisionBinding,
} from "./retrieval.ts";
import type { CodeProviderIdentity, CodeSearchFocus, CodeSearchMode } from "./types.ts";

export interface CanonicalQueryInput {
  operation: RetrievalOperation;
  text: string;
  provider: CodeProviderIdentity;
  workspaceId: string;
  repositories: Array<{ repositoryId: string; snapshot: RepositorySnapshot }>;
  indexRevision?: string;
  mode?: CodeSearchMode;
  focus?: CodeSearchFocus | "mixed";
  filters?: Partial<CanonicalQueryFilters>;
  requestedLimit: number;
}

export interface EvidenceIdentityInput {
  kind: RetrievalEvidenceKind;
  provider: CodeProviderIdentity;
  workspaceId: string;
  repositoryId: string;
  repositoryRevision: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  opaqueId?: string;
}

export function normalizeQueryText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function canonicalizeRetrievalQuery(input: CanonicalQueryInput): CanonicalRetrievalQuery {
  if (!Number.isInteger(input.requestedLimit) || input.requestedLimit < 1) {
    throw new Error("Retrieval requestedLimit must be a positive integer.");
  }
  const normalizedText = normalizeQueryText(input.text);
  if (!normalizedText) throw new Error("Retrieval query text must not be empty after normalization.");
  const binding = canonicalizeRevisionBinding(input);
  const filters = canonicalizeFilters(input.filters);
  const identity = {
    operation: input.operation,
    normalizedText,
    provider: binding.provider,
    workspaceId: binding.workspaceId,
    repositories: binding.repositories,
    ...(binding.indexRevision === undefined ? {} : { indexRevision: binding.indexRevision }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    filters,
  };
  return {
    digest: sha256(stableJson(identity)),
    operation: input.operation,
    normalizedText: identity.normalizedText,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    filters,
    binding,
    requestedLimit: input.requestedLimit,
  };
}

export function canonicalQueryRequestDigest(query: CanonicalRetrievalQuery): string {
  return sha256(stableJson({
    operation: query.operation,
    normalizedText: query.normalizedText,
    ...(query.mode === undefined ? {} : { mode: query.mode }),
    ...(query.focus === undefined ? {} : { focus: query.focus }),
    filters: query.filters,
  }));
}

export function canonicalizeRevisionBinding(input: Pick<CanonicalQueryInput, "provider" | "workspaceId" | "repositories" | "indexRevision">): RetrievalRevisionBinding {
  const repositories = input.repositories
    .map(({ repositoryId, snapshot }): RepositoryRevisionBinding => repositoryRevisionBinding(repositoryId, snapshot))
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  return {
    workspaceId: input.workspaceId,
    provider: canonicalProviderIdentity(input.provider),
    ...(input.indexRevision === undefined ? {} : { indexRevision: input.indexRevision }),
    repositories,
  };
}

export function canonicalizeEvidenceIdentity(input: EvidenceIdentityInput): EvidenceIdentity {
  const identity = {
    kind: input.kind,
    provider: canonicalProviderIdentity(input.provider),
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    path: normalizePath(input.path),
    ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
    ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
    ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
    ...(input.opaqueId === undefined ? {} : { opaqueId: input.opaqueId }),
  };
  return { digest: sha256(stableJson(identity)), ...identity };
}

export function canonicalizeEvidenceIdentities(inputs: EvidenceIdentityInput[]): EvidenceIdentity[] {
  const byDigest = new Map(inputs.map((input) => {
    const identity = canonicalizeEvidenceIdentity(input);
    return [identity.digest, identity] as const;
  }));
  return [...byDigest.values()].sort((left, right) => left.digest.localeCompare(right.digest));
}

export function decideCanonicalQueryReuse(
  cached: CachedQueryCoverage,
  requested: CanonicalRetrievalQuery,
): RetrievalReuseDecision {
  if (cached.query.digest !== requested.digest) {
    return { kind: "provider_call", reason: "canonical query identity differs" };
  }
  if (cached.freshness !== "current") {
    return { kind: "invalidated", reason: `cached evidence freshness is ${cached.freshness}` };
  }
  if (cached.degraded) {
    return { kind: "provider_call", reason: "cached result is degraded" };
  }
  if (cached.truncated || !cached.complete) {
    return { kind: "provider_call", reason: "cached result is incomplete or truncated" };
  }
  if (cached.coveredLimit < requested.requestedLimit) {
    return {
      kind: "provider_call",
      reason: `cached result covers ${cached.coveredLimit} result(s), below requested limit ${requested.requestedLimit}`,
    };
  }
  return { kind: "exact_reuse", reason: `complete cached result covers requested limit ${requested.requestedLimit}` };
}

export function createOpaqueIndexRevision(input: {
  provider: CodeProviderIdentity;
  indexedRevisions: Record<string, string>;
  indexedAt: string;
}): string {
  return sha256(stableJson({
    provider: canonicalProviderIdentity(input.provider),
    indexedRevisions: Object.fromEntries(Object.entries(input.indexedRevisions).sort(([left], [right]) => left.localeCompare(right))),
    indexedAt: input.indexedAt,
  }));
}

function canonicalizeFilters(filters: Partial<CanonicalQueryFilters> | undefined): CanonicalQueryFilters {
  return {
    repositoryIds: sortedUnique(filters?.repositoryIds),
    languages: sortedUnique(filters?.languages),
    pathGlobs: sortedUnique(filters?.pathGlobs),
    literalHints: sortedUnique(filters?.literalHints),
    relationshipKinds: sortedUnique(filters?.relationshipKinds) as CanonicalQueryFilters["relationshipKinds"],
    ...(filters?.includeTests === undefined ? {} : { includeTests: filters.includeTests }),
    ...(filters?.includeGenerated === undefined ? {} : { includeGenerated: filters.includeGenerated }),
    ...(filters?.depth === undefined ? {} : { depth: filters.depth }),
    ...(filters?.reference === undefined ? {} : {
      reference: {
        provider: filters.reference.provider,
        opaqueId: filters.reference.opaqueId,
        repositoryId: filters.reference.repositoryId,
        path: normalizePath(filters.reference.path),
        ...(filters.reference.startLine === undefined ? {} : { startLine: filters.reference.startLine }),
        ...(filters.reference.endLine === undefined ? {} : { endLine: filters.reference.endLine }),
      },
    }),
  };
}

function canonicalProviderIdentity(identity: CodeProviderIdentity): CodeProviderIdentity {
  return {
    name: identity.name,
    ...(identity.version === undefined ? {} : { version: identity.version }),
    instanceId: identity.instanceId,
  };
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
