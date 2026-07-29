import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceRevisionIdentity } from "../repository/snapshot.ts";
import { newId, nowIso } from "../util/ids.ts";
import { createOpaqueIndexRevision } from "./canonical-query.ts";
import type { CodeProvider } from "./provider.ts";
import type {
  CodeChunk,
  CodeIndexState,
  CodeProviderStatus,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchHit,
  CodeSearchQuery,
  CodeSymbolQuery,
  CodeWorkspace,
} from "./types.ts";

export interface MockCodeDocument {
  repositoryId: string;
  repositoryName: string;
  root: string;
  path: string;
  language?: string;
  content: string;
  symbol?: string;
}

export class MockCodeProvider implements CodeProvider {
  readonly name = "mock";
  private indexState: CodeIndexState = "missing";
  private lastIndexedAt?: string;
  private lastQueryAt?: string;
  private indexRevision?: string;
  private readonly documents: MockCodeDocument[];

  constructor(documents: MockCodeDocument[] = []) {
    this.documents = documents;
  }

  async status(): Promise<CodeProviderStatus> {
    return {
      identity: { name: this.name, version: "1", instanceId: "mock-local" },
      available: true,
      healthy: true,
      capabilities: [
        "index.repository",
        "index.multi_repository",
        "index.incremental",
        ...(this.indexRevision === undefined ? [] : ["index.revision_aware" as const]),
        "search.lexical",
        "symbol.search",
        "result.fetch_on_demand",
      ],
      indexState: this.indexState,
      ...(this.indexRevision === undefined ? {} : { indexRevision: this.indexRevision }),
      ...(this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt }),
      ...(this.lastQueryAt === undefined ? {} : { lastQueryAt: this.lastQueryAt }),
    };
  }

  async ensureIndex(workspace: CodeWorkspace): Promise<CodeIndexState> {
    this.indexState = "ready";
    this.lastIndexedAt = nowIso();
    this.indexRevision = createOpaqueIndexRevision({
      provider: { name: this.name, version: "1", instanceId: "mock-local" },
      indexedRevisions: Object.fromEntries(workspace.repositories.map((repository) => [
        repository.id,
        sourceRevisionIdentity(repository.snapshot),
      ])),
      indexedAt: this.lastIndexedAt,
    });
    return this.indexState;
  }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    this.lastQueryAt = nowIso();
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    const allowed = new Set(query.repositoryIds ?? query.workspace.repositories.map((repository) => repository.id));
    const soleRepositoryId = query.workspace.repositories.length === 1 ? query.workspace.repositories[0]!.id : undefined;
    return this.documents
      .map((doc) => ({
        doc,
        repositoryId: allowed.has(doc.repositoryId)
          ? doc.repositoryId
          : doc.repositoryId === "repo"
            ? soleRepositoryId
            : undefined,
        score: terms.reduce((score, term) => score + occurrences(`${doc.path}\n${doc.content}\n${doc.symbol ?? ""}`.toLowerCase(), term), 0),
      }))
      .filter((item): item is typeof item & { repositoryId: string } => item.repositoryId !== undefined && allowed.has(item.repositoryId))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
      .slice(0, query.limit)
      .map(({ doc, repositoryId, score }, index) => this.hit(query, doc, repositoryId, score, index + 1));
  }

  async read(reference: CodeSearchHit["reference"]): Promise<CodeChunk> {
    const doc = this.documents.find((item) => item.repositoryId === reference.repositoryId && item.path === reference.path)
      ?? this.documents.find((item) => item.path === reference.path);
    if (doc === undefined) throw new Error(`Unknown code reference: ${reference.opaqueId}`);
    const provenance = this.provenance("unknown", reference.repositoryId, "", "lexical");
    return {
      reference,
      repositoryId: doc.repositoryId,
      path: doc.path,
      ...(doc.language === undefined ? {} : { language: doc.language }),
      content: doc.content,
      provenance,
    };
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    return this.search({
      workspace: query.workspace,
      text: query.text,
      mode: "lexical",
      ...(query.repositoryIds === undefined ? {} : { repositoryIds: query.repositoryIds }),
      limit: query.limit,
      includeTests: true,
      includeGenerated: false,
    });
  }

  async relationships(_query: CodeRelationshipQuery): Promise<CodeRelationship[]> {
    return [];
  }

  async close(): Promise<void> {}

  private hit(query: CodeSearchQuery, doc: MockCodeDocument, repositoryId: string, score: number, rank: number): CodeSearchHit {
    const lines = doc.content.split("\n");
    const matching = lines.findIndex((line) => query.text.toLowerCase().split(/\s+/).some((term) => line.toLowerCase().includes(term)));
    const startLine = Math.max(1, matching + 1);
    const reference = {
      provider: this.name,
      opaqueId: newId("code-ref"),
      repositoryId,
      path: doc.path,
      startLine,
      endLine: startLine,
    };
    return {
      rank,
      repositoryId,
      repositoryName: doc.repositoryName,
      path: doc.path,
      startLine,
      endLine: startLine,
      ...(doc.symbol === undefined ? {} : { symbol: doc.symbol }),
      ...(doc.language === undefined ? {} : { language: doc.language }),
      retrievalMethods: ["lexical"],
      providerScore: score,
      preview: lines[matching] ?? lines[0] ?? "",
      reference,
      provenance: this.provenance(query.workspace.id, repositoryId, query.text, "lexical"),
    };
  }

  private provenance(workspaceId: string, repositoryId: string, query: string, actualMode: "lexical") {
    return {
      provider: { name: this.name, version: "1", instanceId: "mock-local" },
      workspaceId,
      repositoryId,
      requestedMode: actualMode,
      actualMode,
      query,
      retrievedAt: nowIso(),
      indexState: this.indexState,
      requestedFilters: {},
      enforcedFilters: ["repositoryIds", "limit"],
      postProcessing: [],
      reranked: false,
    };
  }
}

export function loadMockDocuments(root: string, entries: Array<{ repositoryId: string; repositoryName: string; root: string; path: string; language?: string; symbol?: string }>): MockCodeDocument[] {
  return entries.map((entry) => ({
    ...entry,
    content: readFileSync(resolve(root, entry.root, entry.path), "utf8"),
  }));
}

function occurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count += 1;
    offset += term.length;
  }
  return count;
}
