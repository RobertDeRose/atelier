import type { RepositorySnapshot } from "../repository/snapshot.ts";
import type { CodeFreshness, CodeProviderIdentity } from "../domain/code-identity.ts";
export type { CodeFreshness, CodeProviderIdentity } from "../domain/code-identity.ts";

export const CODE_CAPABILITIES = [
  "index.repository",
  "index.multi_repository",
  "index.incremental",
  "index.revision_aware",
  "search.lexical",
  "search.semantic",
  "search.hybrid",
  "symbol.search",
  "symbol.definition",
  "symbol.references",
  "graph.relationships",
  "graph.imports",
  "graph.calls",
  "graph.dependencies",
  "graph.impact",
  "file.outline",
  "result.fetch_on_demand",
  "result.rerank",
] as const;

export type CodeCapability = (typeof CODE_CAPABILITIES)[number];
export type CodeSearchMode = "auto" | "lexical" | "semantic" | "hybrid";
export type CodeSearchFocus = "auto" | "source" | "tests" | "docs" | "all";
export type CodeIndexState = "missing" | "building" | "ready" | "stale" | "failed" | "unknown";

export interface CodeWorkspace {
  id: string;
  name: string;
  roots: string[];
  repositories: Array<{
    id: string;
    name: string;
    root: string;
    snapshot: RepositorySnapshot;
    role?: string;
    tags?: string[];
    codesearchProject?: string;
  }>;
}


export interface CodeProviderStatus {
  identity: CodeProviderIdentity;
  available: boolean;
  healthy: boolean;
  capabilities: CodeCapability[];
  indexState: CodeIndexState;
  /** Opaque provider-neutral token that changes when the observable index revision changes. */
  indexRevision?: string;
  detail?: string;
  lastIndexedAt?: string;
  lastQueryAt?: string;
  indexedRevisions?: Record<string, string>;
  degraded?: boolean;
  warnings?: string[];
}

export interface CodeSearchQuery {
  workspace: CodeWorkspace;
  text: string;
  mode: CodeSearchMode;
  focus?: CodeSearchFocus;
  literalHints?: string[];
  repositoryIds?: string[];
  languages?: string[];
  pathGlobs?: string[];
  limit: number;
  includeTests: boolean;
  includeGenerated: boolean;
}

export interface CodeReference {
  provider: string;
  opaqueId: string;
  repositoryId: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface CodeProvenance {
  provider: CodeProviderIdentity;
  workspaceId: string;
  repositoryId: string;
  requestedMode: CodeSearchMode;
  actualMode: CodeSearchMode;
  query: string;
  retrievedAt: string;
  indexState: CodeIndexState;
  requestedFilters: Record<string, unknown>;
  enforcedFilters: string[];
  postProcessing: string[];
  reranked: boolean;
  freshness?: CodeFreshness;
  indexedRevision?: string;
  currentRevision?: string;
  degraded?: boolean;
  warnings?: string[];
}

export interface AtelierRetrievalObservation {
  kind: "provider_call" | "exact_reuse" | "overlap_reuse" | "direct_read" | "no_provider_call" | "invalidated" | "unsupported" | "budget_denied" | "deduplicated";
  queryDigest: string;
  reason: string;
  observedAt: string;
}

export interface CodeSearchHit {
  rank: number;
  providerRank?: number;
  repositoryId: string;
  repositoryName: string;
  revision?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  language?: string;
  retrievalMethods: CodeSearchMode[];
  providerScore?: number;
  summary?: string;
  preview?: string;
  reference: CodeReference;
  provenance: CodeProvenance;
  provenanceObservations?: CodeProvenance[];
  atelierObservations?: AtelierRetrievalObservation[];
}

export interface CodeChunk {
  reference: CodeReference;
  repositoryId: string;
  path: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  provenance: CodeProvenance;
  provenanceObservations?: CodeProvenance[];
  atelierObservations?: AtelierRetrievalObservation[];
}

export interface CodeSymbolQuery {
  workspace: CodeWorkspace;
  text: string;
  repositoryIds?: string[];
  limit: number;
}

export interface CodeRelationshipQuery {
  workspace: CodeWorkspace;
  reference: CodeReference;
  kinds: Array<"imports" | "calls" | "dependencies" | "references">;
  depth: number;
  limit: number;
}

export interface CodeRelationship {
  kind: "imports" | "calls" | "dependencies" | "references";
  source: CodeReference;
  target: CodeReference;
  label?: string;
  provenance: CodeProvenance;
  provenanceObservations?: CodeProvenance[];
  atelierObservations?: AtelierRetrievalObservation[];
}
