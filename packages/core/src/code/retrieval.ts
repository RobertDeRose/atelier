import type {
  CodeFreshness,
  CodeProviderIdentity,
  CodeSearchFocus,
  CodeSearchMode,
} from "./types.ts";

export type RetrievalOperation = "search" | "symbols" | "relationships";
export type RetrievalEvidenceKind = "path" | "symbol" | "chunk" | "reference";

export interface RepositoryRevisionBinding {
  repositoryId: string;
  snapshotRepositoryId: string;
  workspaceId: string;
  vcs: "jj" | "git" | "none";
  headCommit: string;
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

export interface CanonicalReferenceFilter {
  provider: string;
  opaqueId: string;
  repositoryId: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface CanonicalQueryFilters {
  repositoryIds: string[];
  languages: string[];
  pathGlobs: string[];
  literalHints: string[];
  relationshipKinds: Array<"imports" | "calls" | "dependencies" | "references">;
  includeTests?: boolean;
  includeGenerated?: boolean;
  depth?: number;
  reference?: CanonicalReferenceFilter;
}

export interface CanonicalRetrievalQuery {
  digest: string;
  operation: RetrievalOperation;
  normalizedText: string;
  mode?: CodeSearchMode;
  focus?: CodeSearchFocus | "mixed";
  filters: CanonicalQueryFilters;
  binding: RetrievalRevisionBinding;
  requestedLimit: number;
}

export interface RetrievalSessionRecord {
  id: string;
  status: "active" | "closed";
  binding: RetrievalRevisionBinding;
  budget: RetrievalBudgetSnapshot;
  startedAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface EvidenceIdentity {
  digest: string;
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

export interface RetrievalInventorySummary {
  sessionId: string;
  queryCount: number;
  evidenceCount: number;
  uniquePathCount: number;
  resolvedSymbols: string[];
  knownPaths: string[];
  freshness: CodeFreshness;
  budget: RetrievalBudgetSnapshot;
}

export type RetrievalReuseDecisionKind =
  | "provider_call"
  | "exact_reuse"
  | "overlap_reuse"
  | "direct_read"
  | "invalidated"
  | "unsupported"
  | "budget_denied";

export interface RetrievalReuseDecision {
  kind: RetrievalReuseDecisionKind;
  reason: string;
}

export interface RetrievalBudgetSnapshot {
  providerRequestsUsed: number;
  providerRequestsLimit: number;
  uniquePathsUsed: number;
  uniquePathsLimit: number;
  evidenceEntriesUsed: number;
  evidenceEntriesLimit: number;
  fetchesUsed: number;
  fetchesLimit: number;
  bytesUsed: number;
  bytesLimit: number;
}

export interface RetrievalInvalidation {
  kind: "repository_revision" | "index_revision" | "provider_identity" | "workspace_scope";
  affectedQueryDigests: string[];
  reason: string;
  invalidatedAt: string;
}

export interface RetrievalDiagnostic {
  code: string;
  level: "info" | "warning" | "error";
  message: string;
  queryDigest?: string;
  providerCallRequired?: boolean;
}

export interface RetrievalSessionStatus {
  sessionId: string;
  lastDecision?: RetrievalReuseDecision;
  budget: RetrievalBudgetSnapshot;
  telemetry: RetrievalTelemetry;
  inventory: RetrievalInventorySummary;
  diagnostics: RetrievalDiagnostic[];
}

export interface RetrievalTelemetry {
  providerCalls: number;
  cacheHits: number;
  overlapReuses: number;
  uniquePaths: number;
  duplicatePathsRemoved: number;
  duplicateSymbolsRemoved: number;
  duplicateChunksRemoved: number;
  duplicateReferencesRemoved: number;
  bytesReturned: number;
  truncated: boolean;
  invalidations: number;
}

export interface CachedQueryCoverage {
  query: CanonicalRetrievalQuery;
  coveredLimit: number;
  complete: boolean;
  truncated: boolean;
  degraded: boolean;
  freshness: CodeFreshness;
}
