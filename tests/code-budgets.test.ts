import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodeProvider } from "../packages/core/src/code/provider.ts";
import { CodeProviderRegistry } from "../packages/core/src/code/registry.ts";
import { CodeService, type CodeServiceLimits } from "../packages/core/src/code/service.ts";
import type {
  CodeChunk,
  CodeProviderIdentity,
  CodeProviderStatus,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchHit,
  CodeSearchQuery,
  CodeSymbolQuery,
  CodeWorkspace,
} from "../packages/core/src/code/types.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";

const limits: CodeServiceLimits = {
  maxResults: 10,
  maxPreviewBytes: 200,
  maxChunkBytes: 200,
  maxFetches: 4,
  maxTotalBytes: 4_000,
  maxProviderRequests: 8,
  maxUniquePaths: 16,
  maxEvidenceEntries: 32,
};

function workspace(id = "workspace"): CodeWorkspace {
  return {
    id,
    name: id,
    roots: ["/tmp/a", "/tmp/b"],
    repositories: [
      {
        id: "a",
        name: "a",
        root: "/tmp/a",
        snapshot: {
          repositoryId: "repo-a",
          workspaceId: id,
          vcs: "jj",
          headCommit: "a-commit",
          changeId: "a-change",
          operationId: "a-op",
          dirtyGeneration: 0,
          dirtyFingerprint: "a-clean",
          indexSchemaVersion: 1,
        },
      },
      {
        id: "b",
        name: "b",
        root: "/tmp/b",
        snapshot: {
          repositoryId: "repo-b",
          workspaceId: id,
          vcs: "git",
          headCommit: "b-commit",
          dirtyGeneration: 0,
          dirtyFingerprint: "b-clean",
          indexSchemaVersion: 1,
        },
      },
    ],
  };
}

interface Document {
  repositoryId: string;
  path: string;
  symbol?: string;
  preview?: string;
  reference?: string;
}

class InstrumentedProvider implements CodeProvider {
  readonly name = "instrumented";
  identity: CodeProviderIdentity = { name: this.name, version: "1", instanceId: "local" };
  indexRevision = "index-1";
  degraded = false;
  throwSearch = false;
  capabilities: CodeProviderStatus["capabilities"] = [
    "index.repository",
    "index.multi_repository",
    "index.revision_aware",
    "search.semantic",
    "symbol.search",
    "graph.relationships",
    "result.fetch_on_demand",
  ];
  documents: Document[] = [
    { repositoryId: "a", path: "src/service.ts", symbol: "CodeService", preview: "export class CodeService {}", reference: "service" },
    { repositoryId: "a", path: "src/planner.ts", symbol: "Planner", preview: "export class Planner {}", reference: "planner" },
    { repositoryId: "b", path: "src/remote.ts", symbol: "Remote", preview: "export const Remote = true", reference: "remote" },
  ];
  searchCalls: CodeSearchQuery[] = [];
  symbolCalls: CodeSymbolQuery[] = [];
  relationshipCalls: CodeRelationshipQuery[] = [];
  readCalls = 0;
  statusCalls = 0;

  async status(): Promise<CodeProviderStatus> {
    this.statusCalls += 1;
    return {
      identity: this.identity,
      available: true,
      healthy: true,
      capabilities: this.capabilities,
      indexState: "ready",
      indexRevision: this.indexRevision,
      ...(this.degraded ? { degraded: true, warnings: ["degraded fixture"] } : {}),
    };
  }

  async ensureIndex(): Promise<"ready"> { return "ready"; }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    this.searchCalls.push(query);
    if (this.throwSearch) throw new Error("instrumented search failure");
    const scope = new Set(query.repositoryIds ?? []);
    return this.documents
      .filter((document) => scope.size === 0 || scope.has(document.repositoryId))
      .slice(0, query.limit)
      .map((document, index) => this.hit(query, document, index + 1));
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    this.symbolCalls.push(query);
    const scope = new Set(query.repositoryIds ?? []);
    return this.documents
      .filter((document) => document.symbol === query.text)
      .filter((document) => scope.size === 0 || scope.has(document.repositoryId))
      .slice(0, query.limit)
      .map((document, index) => this.hit({
        workspace: query.workspace,
        text: query.text,
        mode: "lexical",
        ...(query.repositoryIds === undefined ? {} : { repositoryIds: query.repositoryIds }),
        limit: query.limit,
        includeTests: true,
        includeGenerated: false,
      }, document, index + 1));
  }

  async relationships(query: CodeRelationshipQuery): Promise<CodeRelationship[]> {
    this.relationshipCalls.push(query);
    return [{
      kind: query.kinds[0] ?? "references",
      source: query.reference,
      target: { provider: this.name, opaqueId: "target", repositoryId: query.reference.repositoryId, path: "src/target.ts" },
      provenance: this.provenance(query.workspace.id, query.reference.repositoryId, query.reference.path, "auto"),
    }];
  }

  async read(reference: CodeSearchHit["reference"]): Promise<CodeChunk> {
    this.readCalls += 1;
    return {
      reference,
      repositoryId: reference.repositoryId,
      path: reference.path,
      content: "x".repeat(100),
      provenance: this.provenance("workspace", reference.repositoryId, reference.path, "auto"),
    };
  }

  async close(): Promise<void> {}

  private hit(query: CodeSearchQuery, document: Document, rank: number): CodeSearchHit {
    return {
      rank,
      providerRank: rank,
      repositoryId: document.repositoryId,
      repositoryName: document.repositoryId,
      path: document.path,
      startLine: rank,
      endLine: rank + 1,
      ...(document.symbol === undefined ? {} : { symbol: document.symbol }),
      ...(document.preview === undefined ? {} : { preview: document.preview }),
      retrievalMethods: [query.mode],
      reference: {
        provider: this.name,
        opaqueId: document.reference ?? `${document.repositoryId}:${document.path}:${rank}`,
        repositoryId: document.repositoryId,
        path: document.path,
        startLine: rank,
        endLine: rank + 1,
      },
      provenance: this.provenance(query.workspace.id, document.repositoryId, query.text, query.mode),
    };
  }

  private provenance(workspaceId: string, repositoryId: string, query: string, mode: "auto" | "lexical" | "semantic" | "hybrid") {
    return {
      provider: this.identity,
      workspaceId,
      repositoryId,
      requestedMode: mode,
      actualMode: mode,
      query,
      retrievedAt: "2026-01-01T00:00:00.000Z",
      indexState: "ready" as const,
      indexRevision: this.indexRevision,
      requestedFilters: {},
      enforcedFilters: [],
      postProcessing: [],
      reranked: false,
      ...(this.degraded ? { degraded: true, warnings: ["degraded fixture"] } : {}),
    };
  }
}

function service(provider = new InstrumentedProvider(), overrides: Partial<CodeServiceLimits> = {}) {
  const ledger = new SqliteLedger(join(mkdtempSync(join(tmpdir(), "atlr-retrieval-session-")), "state.db"));
  const code = new CodeService(
    new CodeProviderRegistry([provider], provider.name),
    ledger,
    { ...limits, ...overrides },
    "session-test",
  );
  return { code, ledger, provider };
}

test("CodeService shares workspace-qualified provider status across retrieval hot paths", async () => {
  const { code, ledger, provider } = service();
  const currentWorkspace = workspace();
  try {
    const hits = await code.search({ workspace: currentWorkspace, text: "service", mode: "semantic", repositoryIds: ["a"], limit: 5 });
    await code.symbols({ workspace: currentWorkspace, text: "CodeService", repositoryIds: ["a"], limit: 5, requireUnresolved: false });
    await code.relationships({
      workspace: currentWorkspace,
      reference: hits[0]!.reference,
      kinds: ["references"],
      depth: 1,
      limit: 5,
    });
    assert.equal(provider.statusCalls, 1);
  } finally { await code.close(); ledger.close(); }
});

test("Given an unchanged exact query, repeated retrieval reuses one provider call", async () => {
  const { code, ledger, provider } = service();
  try {
    const first = await code.search({ workspace: workspace(), text: "service", mode: "semantic", repositoryIds: ["a"], limit: 5 });
    const second = await code.search({ workspace: workspace(), text: "  service\n", mode: "semantic", repositoryIds: ["a"], limit: 5 });
    assert.equal(provider.searchCalls.length, 1);
    assert.deepEqual(second.map((hit) => hit.path), first.map((hit) => hit.path));
    assert.equal(second[0]?.provenance, first[0]?.provenance);
    assert.equal(second[0]?.atelierObservations?.at(-1)?.kind, "exact_reuse");
    assert.equal(code.retrievalStatus().lastDecision?.kind, "exact_reuse");
    assert.equal(ledger.listEvents({ kind: "code.retrieval_reused" }).length, 1);
  } finally { await code.close(); ledger.close(); }
});

test("Given greater cached coverage, a smaller limit reuses it but a greater limit does not reuse lower coverage", async () => {
  const first = service();
  try {
    await first.code.search({ workspace: workspace(), text: "service", limit: 3 });
    assert.equal((await first.code.search({ workspace: workspace(), text: "service", limit: 1 })).length, 1);
    assert.equal(first.provider.searchCalls.length, 1);
  } finally { await first.code.close(); first.ledger.close(); }

  const second = service();
  try {
    await second.code.search({ workspace: workspace(), text: "service", limit: 1 });
    await second.code.search({ workspace: workspace(), text: "service", limit: 3 });
    assert.equal(second.provider.searchCalls.length, 2);
  } finally { await second.code.close(); second.ledger.close(); }
});

test("Given truncated or degraded evidence, repetition calls the provider again", async () => {
  const truncated = service(undefined, { maxUniquePaths: 1 });
  try {
    await truncated.code.search({ workspace: workspace(), text: "service", limit: 3 });
    await truncated.code.search({ workspace: workspace(), text: "service", limit: 3 });
    assert.equal(truncated.provider.searchCalls.length, 2);
    assert.equal(truncated.code.retrievalStatus().telemetry.truncated, true);
  } finally { await truncated.code.close(); truncated.ledger.close(); }

  const degradedProvider = new InstrumentedProvider();
  const degraded = service(degradedProvider);
  try {
    await degraded.code.search({ workspace: workspace(), text: "service", limit: 3 });
    degradedProvider.degraded = true;
    degraded.code.invalidateStatus();
    await degraded.code.search({ workspace: workspace(), text: "service", limit: 3 });
    await degraded.code.search({ workspace: workspace(), text: "service", limit: 3 });
    assert.equal(degradedProvider.searchCalls.length, 3);
  } finally { await degraded.code.close(); degraded.ledger.close(); }
});

test("Given inventoried paths and symbols, direct-read and safe overlap decisions avoid provider calls", async () => {
  const { code, ledger, provider } = service();
  try {
    await code.search({ workspace: workspace(), text: "service", repositoryIds: ["a"], limit: 5 });
    const alreadyResolved = await code.symbols({ workspace: workspace(), text: "CodeService", repositoryIds: ["a"], limit: 5 });
    assert.equal(provider.symbolCalls.length, 0, "resolved semantic evidence must suppress redundant symbol lookup");
    assert.equal(alreadyResolved[0]?.atelierObservations?.at(-1)?.kind, "overlap_reuse");

    const symbol = await code.search({ workspace: workspace(), text: "CodeService", repositoryIds: ["a"], limit: 5 });
    assert.equal(provider.searchCalls.length, 1);
    assert.equal(symbol[0]?.atelierObservations?.at(-1)?.kind, "overlap_reuse");

    const direct = await code.search({ workspace: workspace(), text: "src/service.ts", repositoryIds: ["a"], limit: 5 });
    assert.equal(provider.searchCalls.length, 1);
    assert.equal(direct[0]?.atelierObservations?.at(-1)?.kind, "direct_read");
  } finally { await code.close(); ledger.close(); }
});

test("Given provider, repository, or index drift, cached evidence is invalidated before a fresh provider call", async () => {
  const { code, ledger, provider } = service();
  const work = workspace();
  try {
    await code.search({ workspace: work, text: "service", repositoryIds: ["a"], limit: 5 });
    work.repositories[0]!.snapshot.dirtyFingerprint = "a-dirty";
    await code.search({ workspace: work, text: "service", repositoryIds: ["a"], limit: 5 });
    assert.match(code.retrievalStatus().lastDecision?.reason ?? "", /repository revision changed/i);
    provider.indexRevision = "index-2";
    code.invalidateStatus();
    await code.search({ workspace: work, text: "service", repositoryIds: ["a"], limit: 5 });
    assert.match(code.retrievalStatus().lastDecision?.reason ?? "", /index revision changed/i);
    provider.identity = { ...provider.identity, instanceId: "remote" };
    code.invalidateStatus();
    await code.search({ workspace: work, text: "service", repositoryIds: ["a"], limit: 5 });
    assert.match(code.retrievalStatus().lastDecision?.reason ?? "", /provider identity changed/i);

    assert.equal(provider.searchCalls.length, 4);
    assert.equal(code.retrievalStatus().telemetry.invalidations, 3);
    assert.equal(code.retrievalStatus().lastDecision?.kind, "invalidated");
  } finally { await code.close(); ledger.close(); }
});

test("Given a provider error, the failed request is never cached", async () => {
  const provider = new InstrumentedProvider();
  const { code, ledger } = service(provider);
  try {
    provider.throwSearch = true;
    await assert.rejects(code.search({ workspace: workspace(), text: "service", limit: 5 }), /instrumented search failure/);
    provider.throwSearch = false;
    await code.search({ workspace: workspace(), text: "service", limit: 5 });
    assert.equal(provider.searchCalls.length, 2);
  } finally { await code.close(); ledger.close(); }
});

test("Given an unsupported capability, Atelier rejects before consuming provider budget", async () => {
  const provider = new InstrumentedProvider();
  provider.capabilities = provider.capabilities.filter((capability) => capability !== "symbol.search");
  const { code, ledger } = service(provider);
  try {
    await code.search({ workspace: workspace(), text: "UnknownSymbol", literalHints: ["UnknownSymbol"], limit: 5 });
    await assert.rejects(code.symbols({ workspace: workspace(), text: "UnknownSymbol", limit: 5 }), /does not support symbol.search/i);
    assert.equal(provider.symbolCalls.length, 0);
    assert.equal(code.retrievalStatus().lastDecision?.kind, "unsupported");
    assert.equal(code.retrievalStatus().budget.providerRequestsUsed, 1);
  } finally { await code.close(); ledger.close(); }
});

test("Given exhausted provider requests, retrieval fails without raw-scan fallback", async () => {
  const { code, ledger, provider } = service(undefined, { maxProviderRequests: 1 });
  try {
    await code.search({ workspace: workspace(), text: "service", limit: 5 });
    await assert.rejects(
      code.search({ workspace: workspace(), text: "different", limit: 5 }),
      /request budget exhausted.*Raw scanning is not an automatic fallback/i,
    );
    assert.equal(provider.searchCalls.length, 1);
    assert.equal(code.retrievalStatus().lastDecision?.kind, "budget_denied");

    code.beginRetrievalSession("session-next");
    await code.search({ workspace: workspace(), text: "different", limit: 5 });
    assert.equal(provider.searchCalls.length, 2);
    assert.equal(code.retrievalStatus().sessionId, "session-next");
    assert.equal(code.retrievalStatus().budget.providerRequestsUsed, 1);
  } finally { await code.close(); ledger.close(); }
});

test("Given a result limit, Atelier bounds the provider request and model-facing result", async () => {
  const { code, ledger, provider } = service(undefined, { maxResults: 1 });
  try {
    const results = await code.search({ workspace: workspace(), text: "anything", limit: 10 });
    assert.equal(provider.searchCalls[0]?.limit, 1);
    assert.equal(results.length, 1);
  } finally { await code.close(); ledger.close(); }
});

test("Given duplicate chunks and paths, unique path, entry, and byte budgets are deterministic", async () => {
  const provider = new InstrumentedProvider();
  provider.documents = [
    { repositoryId: "a", path: "src/repeated.ts", symbol: "A", preview: "a".repeat(100), reference: "one" },
    { repositoryId: "a", path: "src/repeated.ts", symbol: "B", preview: "b".repeat(100), reference: "two" },
    { repositoryId: "a", path: "src/other.ts", symbol: "C", preview: "c".repeat(100), reference: "three" },
  ];
  const { code, ledger } = service(provider, { maxUniquePaths: 1, maxEvidenceEntries: 2, maxTotalBytes: 30, maxPreviewBytes: 30 });
  try {
    const results = await code.search({ workspace: workspace(), text: "anything", repositoryIds: ["a"], limit: 10 });
    const status = code.retrievalStatus();
    assert.deepEqual(results.map((hit) => hit.path), ["src/repeated.ts"]);
    assert.equal(results[0]?.symbol, "A", "deduplication must retain the provider's first-ranked path candidate");
    assert.match(results[0]?.preview ?? "", /truncated/);
    assert.ok(Buffer.byteLength(results[0]?.preview ?? "") <= 30);
    assert.equal(status.budget.uniquePathsUsed, 1);
    assert.equal(status.budget.evidenceEntriesUsed, 2);
    assert.ok(status.budget.bytesUsed <= 30);
    assert.ok(status.telemetry.duplicateResultsRemoved >= 1);
    assert.ok(status.telemetry.duplicatePathsRemoved >= 1);
    assert.equal(status.telemetry.truncated, true);
    assert.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "unique_path_budget_truncated"));
    assert.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "evidence_byte_budget_truncated"));
  } finally { await code.close(); ledger.close(); }
});

test("Given fetch limits, chunk count and total bytes are session-scoped", async () => {
  const provider = new InstrumentedProvider();
  provider.documents = [{ repositoryId: "a", path: "src/no-preview.ts", reference: "fetch" }];
  const { code, ledger } = service(provider, { maxFetches: 1, maxChunkBytes: 20, maxTotalBytes: 20 });
  try {
    const [hit] = await code.search({ workspace: workspace(), text: "fetch", repositoryIds: ["a"], limit: 1 });
    const chunk = await code.read(hit!.reference);
    assert.ok(Buffer.byteLength(chunk.content) <= 20);
    await assert.rejects(code.read(hit!.reference), /fetch budget exceeded/i);
    assert.equal(provider.readCalls, 1);
    assert.equal(code.retrievalStatus().telemetry.providerCalls, 2);
  } finally { await code.close(); ledger.close(); }
});

test("Complete fetched chunks reuse only while repository and index bindings remain current", async () => {
  const provider = new InstrumentedProvider();
  provider.documents = [{ repositoryId: "a", path: "src/chunk.ts", reference: "chunk" }];
  const { code, ledger } = service(provider, { maxChunkBytes: 200, maxTotalBytes: 500 });
  const work = workspace();
  try {
    const [hit] = await code.search({ workspace: work, text: "chunk", repositoryIds: ["a"], limit: 1 });
    await code.read(hit!.reference);
    const reused = await code.read(hit!.reference);
    assert.equal(provider.readCalls, 1);
    assert.equal(reused.atelierObservations?.at(-1)?.kind, "exact_reuse");

    work.repositories[0]!.snapshot.dirtyFingerprint = "changed-after-fetch";
    await code.read(hit!.reference);
    assert.equal(provider.readCalls, 2);
    assert.equal(code.retrievalStatus().lastDecision?.kind, "invalidated");
  } finally { await code.close(); ledger.close(); }
});

test("Symbols and relationships share request accounting and exact reuse", async () => {
  const { code, ledger, provider } = service(undefined, { maxProviderRequests: 3 });
  try {
    await code.search({ workspace: workspace(), text: "UnknownSymbol", literalHints: ["UnknownSymbol"], repositoryIds: ["a"], limit: 5 });
    await code.symbols({ workspace: workspace(), text: "UnknownSymbol", repositoryIds: ["a"], limit: 5 });
    await code.symbols({ workspace: workspace(), text: "UnknownSymbol", repositoryIds: ["a"], limit: 5 });
    const reference = { provider: provider.name, opaqueId: "source", repositoryId: "a", path: "src/source.ts" };
    const query = { workspace: workspace(), reference, kinds: ["references" as const], depth: 1, limit: 5 };
    await code.relationships(query);
    await code.relationships(query);
    assert.equal(provider.symbolCalls.length, 1);
    assert.equal(provider.relationshipCalls.length, 1);
    assert.equal(code.retrievalStatus().budget.providerRequestsUsed, 3);
  } finally { await code.close(); ledger.close(); }
});

test("Multi-repository and workspace scopes never reuse or leak evidence", async () => {
  const { code, ledger, provider } = service();
  try {
    const a = await code.search({ workspace: workspace(), text: "scope", repositoryIds: ["a"], limit: 5 });
    const b = await code.search({ workspace: workspace(), text: "scope", repositoryIds: ["b"], limit: 5 });
    const aAgain = await code.search({ workspace: workspace(), text: "scope", repositoryIds: ["a"], limit: 5 });
    await code.search({ workspace: workspace("other-workspace"), text: "scope", repositoryIds: ["a"], limit: 5 });

    assert.deepEqual(new Set(a.map((hit) => hit.repositoryId)), new Set(["a"]));
    assert.deepEqual(new Set(b.map((hit) => hit.repositoryId)), new Set(["b"]));
    assert.deepEqual(new Set(aAgain.map((hit) => hit.repositoryId)), new Set(["a"]));
    assert.equal(provider.searchCalls.length, 3);
  } finally { await code.close(); ledger.close(); }
});
