import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { CodeProviderRegistry } from "./registry.ts";
import type { CodeChunk, CodeRelationship, CodeRelationshipQuery, CodeSearchHit, CodeSearchMode, CodeWorkspace } from "./types.ts";

export class CodeService {
  private readonly registry: CodeProviderRegistry;
  private readonly ledger: SqliteLedger;
  private readonly limits: { maxResults: number; maxPreviewBytes: number; maxChunkBytes: number; maxFetches: number; maxTotalBytes: number };
  private fetched = 0;
  private retrievedBytes = 0;

  constructor(registry: CodeProviderRegistry, ledger: SqliteLedger, limits = { maxResults: 10, maxPreviewBytes: 2000, maxChunkBytes: 16000, maxFetches: 8, maxTotalBytes: 64000 }) {
    this.registry = registry;
    this.ledger = ledger;
    this.limits = limits;
  }

  providers() { return this.registry.statuses(); }

  async status(provider?: string) { return this.registry.get(provider).status(); }

  async ensureIndex(workspace: CodeWorkspace, provider?: string) {
    const selected = this.registry.get(provider);
    const state = await selected.ensureIndex(workspace);
    this.ledger.append({ kind: "code.index_requested", actor: "user", payload: { provider: selected.name, workspaceId: workspace.id, state } });
    return state;
  }

  async search(options: { workspace: CodeWorkspace; text: string; mode?: CodeSearchMode; repositoryIds?: string[]; limit?: number; provider?: string }): Promise<CodeSearchHit[]> {
    const selected = this.registry.get(options.provider);
    const results = await selected.search({
      workspace: options.workspace,
      text: options.text,
      mode: options.mode ?? "auto",
      ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
      limit: Math.min(options.limit ?? this.limits.maxResults, this.limits.maxResults),
      includeTests: true,
      includeGenerated: false,
    });
    const bounded = results.slice(0, this.limits.maxResults).map((hit) => ({ ...hit, ...(hit.preview === undefined ? {} : { preview: truncateUtf8(hit.preview, this.limits.maxPreviewBytes) }) }));
    this.ledger.append({ kind: "code.search_completed", actor: "system", payload: { provider: selected.name, workspaceId: options.workspace.id, query: options.text, resultCount: bounded.length, truncated: results.length > bounded.length } });
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
    const selected = this.registry.get(options.provider);
    return selected.symbols({ workspace: options.workspace, text: options.text, ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }), limit: options.limit ?? 10 });
  }

  async relationships(query: CodeRelationshipQuery, provider?: string): Promise<CodeRelationship[]> {
    return this.registry.get(provider).relationships(query);
  }

  close() { return this.registry.close(); }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value; while (result && Buffer.byteLength(result) > maxBytes) result = result.slice(0, Math.max(0, result.length - Math.ceil((Buffer.byteLength(result)-maxBytes)/2)));
  return `${result}\n…[truncated by Atelier retrieval budget]`;
}
