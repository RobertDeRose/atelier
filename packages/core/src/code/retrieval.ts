import type {
  CodeFreshness,
  CodeProviderIdentity,
  CodeProvenance,
  CodeRelationship,
  CodeSearchFocus,
  CodeSearchHit,
  CodeSearchMode,
} from "./types.ts";

import type { RepositoryRevisionBinding, RetrievalRevisionBinding } from "../repository/revision-binding.ts";
export type { RepositoryRevisionBinding, RetrievalRevisionBinding } from "../repository/revision-binding.ts";

import type {
  RetrievalBudgetSnapshot,
  RetrievalDecisionRecord,
  RetrievalDiagnostic,
  RetrievalInvalidation,
  RetrievalOperation,
  RetrievalPersistenceStatus,
  RetrievalReuseDecision,
  RetrievalTelemetry,
} from "../domain/retrieval-state.ts";
export type {
  RetrievalBudgetSnapshot,
  RetrievalDecisionRecord,
  RetrievalDiagnostic,
  RetrievalInvalidation,
  RetrievalOperation,
  RetrievalPersistenceStatus,
  RetrievalReuseDecision,
  RetrievalReuseDecisionKind,
  RetrievalTelemetry,
} from "../domain/retrieval-state.ts";

export type RetrievalEvidenceKind = "path" | "symbol" | "chunk" | "reference";

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
  semanticDiscoveryComplete: boolean;
  evidenceCount: number;
  uniquePathCount: number;
  resolvedSymbols: string[];
  unresolvedSymbols: string[];
  knownPaths: string[];
  freshness: CodeFreshness;
  budget: RetrievalBudgetSnapshot;
}

export interface PersistedRetrievalRequest extends CachedQueryCoverage {
  requestDigest: string;
  evidenceDigests: string[];
  decision: RetrievalReuseDecision;
}

export type CompactHitValue = Omit<CodeSearchHit, "provenance" | "provenanceObservations">;
export type CompactRelationshipValue = Omit<CodeRelationship, "provenance" | "provenanceObservations">;

export interface PersistedRetrievalEvidence {
  digest: string;
  kind: "hit" | "relationship";
  queryDigests: string[];
  value: CompactHitValue | CompactRelationshipValue;
  provenance: CodeProvenance[];
}

export interface PersistedRetrievalCheckpoint {
  sessionId: string;
  status: "active" | "closed";
  startedAt: string;
  updatedAt: string;
  budget: RetrievalBudgetSnapshot;
  telemetry: RetrievalTelemetry;
  lastDecision?: RetrievalReuseDecision;
  requests: PersistedRetrievalRequest[];
  evidence: PersistedRetrievalEvidence[];
  invalidations: RetrievalInvalidation[];
  diagnostics: RetrievalDiagnostic[];
  decisions: RetrievalDecisionRecord[];
}

export interface RetrievalPersistenceLimits {
  maxRetainedSessions: number;
  maxEntries: number;
  maxBytes: number;
}

export interface ScopedUnresolvedSymbol {
  workspaceId: string;
  repositoryIds: string[];
  symbol: string;
}

export interface RetrievalSessionStatus {
  sessionId: string;
  lastDecision?: RetrievalReuseDecision;
  budget: RetrievalBudgetSnapshot;
  telemetry: RetrievalTelemetry;
  persistence: RetrievalPersistenceStatus;
  inventory: RetrievalInventorySummary;
  diagnostics: RetrievalDiagnostic[];
  invalidations: RetrievalInvalidation[];
  decisions: RetrievalDecisionRecord[];
  evidence: PersistedRetrievalEvidence[];
  bindings: RetrievalRevisionBinding[];
  semanticDiscoveryBindings: RetrievalRevisionBinding[];
  unresolvedSymbolScopes: ScopedUnresolvedSymbol[];
}

export interface CachedQueryCoverage {
  query: CanonicalRetrievalQuery;
  coveredLimit: number;
  complete: boolean;
  truncated: boolean;
  degraded: boolean;
  freshness: CodeFreshness;
}
