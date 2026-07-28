export type RetrievalOperation = "search" | "symbols" | "relationships";

export type RetrievalReuseDecisionKind =
  | "provider_call"
  | "exact_reuse"
  | "overlap_reuse"
  | "direct_read"
  | "no_provider_call"
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

export interface RetrievalDecisionRecord {
  queryDigest: string;
  operation: RetrievalOperation;
  workspaceId: string;
  repositoryIds: string[];
  decision: RetrievalReuseDecision;
  decidedAt: string;
}

export interface RetrievalPersistenceStatus {
  retainedSessionsUsed: number;
  retainedSessionsLimit: number;
  entriesUsed: number;
  entriesLimit: number;
  bytesUsed: number;
  bytesLimit: number;
}

export interface RetrievalTelemetry {
  providerCalls: number;
  cacheHits: number;
  overlapReuses: number;
  uniquePaths: number;
  duplicateResultsRemoved: number;
  duplicatePathsRemoved: number;
  duplicateSymbolsRemoved: number;
  duplicateChunksRemoved: number;
  duplicateReferencesRemoved: number;
  bytesReturned: number;
  truncated: boolean;
  invalidations: number;
}
