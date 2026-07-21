import type { RepositorySnapshot } from "../domain/types.ts";

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
export type CodeIndexState = "missing" | "building" | "ready" | "stale" | "failed" | "unknown";
export type CodeFreshness = "current" | "possibly_stale" | "known_stale" | "unknown";

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

export interface CodeProviderIdentity {
  name: string;
  version?: string;
  instanceId: string;
}

export interface CodeProviderStatus {
  identity: CodeProviderIdentity;
  available: boolean;
  healthy: boolean;
  capabilities: CodeCapability[];
  indexState: CodeIndexState;
  detail?: string;
  lastIndexedAt?: string;
  lastQueryAt?: string;
  indexedRevisions?: Record<string, string>;
}

export interface CodeSearchQuery {
  workspace: CodeWorkspace;
  text: string;
  mode: CodeSearchMode;
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
}

export interface CodeSearchHit {
  rank: number;
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
}
