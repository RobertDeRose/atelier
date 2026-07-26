import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { CodeProviderRegistry } from "./registry.ts";
import type { CodeChunk, CodeIndexState, CodeRelationship, CodeRelationshipQuery, CodeSearchFocus, CodeSearchHit, CodeSearchMode, CodeWorkspace } from "./types.ts";

export interface CodeIndexCoordinatorStatus {
  state: CodeIndexState;
  active: boolean;
  provider?: string;
  workspaceId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

type CodeIndexStatusListener = (status: CodeIndexCoordinatorStatus) => void;

export class CodeService {
  private readonly registry: CodeProviderRegistry;
  private readonly ledger: SqliteLedger;
  private readonly limits: { maxResults: number; maxPreviewBytes: number; maxChunkBytes: number; maxFetches: number; maxTotalBytes: number };
  private fetched = 0;
  private retrievedBytes = 0;
  private activeIndex: Promise<CodeIndexState> | undefined;
  private indexStatus: CodeIndexCoordinatorStatus = { state: "unknown", active: false };
  private readonly indexListeners = new Set<CodeIndexStatusListener>();

  constructor(registry: CodeProviderRegistry, ledger: SqliteLedger, limits = { maxResults: 10, maxPreviewBytes: 2000, maxChunkBytes: 16000, maxFetches: 8, maxTotalBytes: 64000 }) {
    this.registry = registry;
    this.ledger = ledger;
    this.limits = limits;
  }

  providers(workspace?: CodeWorkspace) { return this.registry.statuses(workspace); }

  async status(provider?: string, workspace?: CodeWorkspace) {
    const selected = this.registry.get(provider);
    if (this.activeIndex !== undefined && this.indexStatus.provider === selected.name) {
      return {
        identity: { name: selected.name, instanceId: `${selected.name}-index-coordinator` },
        available: true,
        healthy: true,
        capabilities: [],
        indexState: "building" as const,
        detail: "Atelier background indexing is active. Searches and index requests will join this operation.",
      };
    }
    return selected.status(workspace);
  }

  indexingStatus(): CodeIndexCoordinatorStatus {
    return { ...this.indexStatus };
  }

  onIndexStatus(listener: CodeIndexStatusListener): () => void {
    this.indexListeners.add(listener);
    listener(this.indexingStatus());
    return () => this.indexListeners.delete(listener);
  }

  async ensureIndex(workspace: CodeWorkspace, provider?: string) {
    if (this.activeIndex !== undefined) return this.activeIndex;
    const selected = this.registry.get(provider);
    this.setIndexStatus({
      state: "building",
      active: true,
      provider: selected.name,
      workspaceId: workspace.id,
      startedAt: new Date().toISOString(),
    });
    const operation = (async () => {
      try {
        const state = await selected.ensureIndex(workspace);
        const { error: _previousError, ...statusWithoutError } = this.indexStatus;
        this.setIndexStatus({
          ...statusWithoutError,
          state,
          active: false,
          completedAt: new Date().toISOString(),
        });
        this.ledger.append({ kind: "code.index_completed", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id, state } });
        return state;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setIndexStatus({
          ...this.indexStatus,
          state: "failed",
          active: false,
          completedAt: new Date().toISOString(),
          error: message,
        });
        this.ledger.append({ kind: "code.index_failed", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id, error: message } });
        throw error;
      } finally {
        this.activeIndex = undefined;
      }
    })();
    this.activeIndex = operation;
    this.ledger.append({ kind: "code.index_requested", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id } });
    return operation;
  }

  async search(options: { workspace: CodeWorkspace; text: string; mode?: CodeSearchMode; focus?: CodeSearchFocus; literalHints?: string[]; repositoryIds?: string[]; limit?: number; provider?: string }): Promise<CodeSearchHit[]> {
    await this.waitForActiveIndex();
    const selected = this.registry.get(options.provider);
    const results = await selected.search({
      workspace: options.workspace,
      text: options.text,
      mode: options.mode ?? "auto",
      focus: options.focus ?? "auto",
      ...(options.literalHints === undefined ? {} : { literalHints: options.literalHints }),
      ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
      limit: Math.min(options.limit ?? this.limits.maxResults, this.limits.maxResults),
      includeTests: true,
      includeGenerated: false,
    });
    const bounded = results.slice(0, this.limits.maxResults).map((hit) => ({ ...hit, ...(hit.preview === undefined ? {} : { preview: truncateUtf8(hit.preview, this.limits.maxPreviewBytes) }) }));
    const warnings = [...new Set(bounded.flatMap((hit) => hit.provenance.warnings ?? []))];
    this.ledger.append({ kind: "code.search_completed", actor: "system", payload: { provider: selected.name, workspaceId: options.workspace.id, query: options.text, focus: options.focus ?? "auto", resultCount: bounded.length, truncated: results.length > bounded.length, degraded: bounded.some((hit) => hit.provenance.degraded === true), warnings } });
    return bounded;
  }

  async read(reference: CodeSearchHit["reference"], provider?: string): Promise<CodeChunk> {
    if (this.fetched >= this.limits.maxFetches) throw new Error(`Code fetch budget exceeded (${this.limits.maxFetches})`);
    const chunk = await this.registry.get(provider ?? reference.provider).read(reference);
    const content = truncateUtf8(chunk.content, Math.min(this.limits.maxChunkBytes, this.limits.maxTotalBytes - this.retrievedBytes));
    this.fetched += 1; this.retrievedBytes += Buffer.byteLength(content);
    return { ...chunk, content };
  }

  async symbols(options: { workspace: CodeWorkspace; text: string; repositoryIds?: string[]; limit?: number; provider?: string }): Promise<CodeSearchHit[]> {
    await this.waitForActiveIndex();
    const selected = this.registry.get(options.provider);
    return selected.symbols({ workspace: options.workspace, text: options.text, ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }), limit: options.limit ?? 10 });
  }

  async relationships(query: CodeRelationshipQuery, provider?: string): Promise<CodeRelationship[]> {
    await this.waitForActiveIndex();
    return this.registry.get(provider).relationships(query);
  }

  close() { return this.registry.close(); }

  private async waitForActiveIndex(): Promise<void> {
    if (this.activeIndex !== undefined) await this.activeIndex;
  }

  private setIndexStatus(status: CodeIndexCoordinatorStatus): void {
    this.indexStatus = status;
    for (const listener of this.indexListeners) listener(this.indexingStatus());
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value; while (result && Buffer.byteLength(result) > maxBytes) result = result.slice(0, Math.max(0, result.length - Math.ceil((Buffer.byteLength(result)-maxBytes)/2)));
  return `${result}\n…[truncated by Atelier retrieval budget]`;
}
