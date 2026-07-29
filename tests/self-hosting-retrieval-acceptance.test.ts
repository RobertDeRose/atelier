import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CodeProviderRegistry,
  CodeService,
  InMemoryTaskProvider,
  SqliteLedger,
  WorkingStateBuilder,
  sourceRevisionIdentity,
  type CodeProvider,
  type CodeProviderStatus,
  type CodeSearchHit,
  type CodeSearchQuery,
  type CodeSymbolQuery,
  type CodeWorkspace,
} from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

type Scenario = {
  objective: string;
  budgets: { maxRepositoryIntelligenceCalls: number; maxProviderCalls: number };
  expectedOutcome: {
    agentToolCalls: number;
    providerCalls: number;
    cacheHits: number;
    uniquePaths: number;
    duplicateIdentitiesRemovedMinimum: number;
    invalidationsMinimum: number;
    truncation: boolean;
  };
  expectedPathGroups: Record<string, string[]>;
};

class SelfHostingProvider implements CodeProvider {
  readonly name = "self-hosting-fake";
  readonly identity = { name: this.name, version: "1", instanceId: "portable" };
  readonly capabilities: CodeProviderStatus["capabilities"] = [
    "index.repository",
    "index.multi_repository",
    "index.revision_aware",
    "search.semantic",
    "symbol.search",
  ];
  indexRevision = "index-1";
  searchCalls: CodeSearchQuery[] = [];
  symbolCalls: CodeSymbolQuery[] = [];

  async status(): Promise<CodeProviderStatus> {
    return {
      identity: this.identity,
      available: true,
      healthy: true,
      capabilities: this.capabilities,
      indexState: "ready",
      indexRevision: this.indexRevision,
    };
  }

  async ensureIndex(): Promise<"ready"> { return "ready"; }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    this.searchCalls.push(query);
    const repositories = new Set(query.repositoryIds ?? query.workspace.repositories.map((repository) => repository.id));
    const documents = [
      { repositoryId: "atelier", path: "packages/core/src/code/service.ts", symbol: "CodeService" },
      { repositoryId: "atelier", path: "packages/core/src/code/service.ts", symbol: "DuplicateCodeService" },
      { repositoryId: "atelier", path: "packages/core/src/state/working-state-builder.ts", symbol: "WorkingStateBuilder" },
      { repositoryId: "atelier", path: "apps/pi-extension/src/index.ts", symbol: "atelierExtension" },
      { repositoryId: "docs", path: "docs/CODE_INTELLIGENCE.md", symbol: "CodeIntelligenceGuide" },
    ].filter((document) => repositories.has(document.repositoryId));
    return documents.map((document, index) => this.hit(query, document.repositoryId, document.path, document.symbol, index));
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    this.symbolCalls.push(query);
    if (query.text !== "UnresolvedInventorySymbol") return [];
    const repositoryId = query.repositoryIds?.[0] ?? "atelier";
    return [this.hit({
      workspace: query.workspace,
      text: query.text,
      mode: "lexical",
      limit: query.limit,
      includeTests: true,
      includeGenerated: false,
      ...(query.repositoryIds === undefined ? {} : { repositoryIds: query.repositoryIds }),
    }, repositoryId, "packages/core/src/code/retrieval.ts", query.text, 0)];
  }

  async relationships(): Promise<[]> { return []; }
  async read(): Promise<never> { throw new Error("direct paths must use the built-in read tool"); }
  async close(): Promise<void> {}

  private hit(query: CodeSearchQuery, repositoryId: string, path: string, symbol: string, rank: number): CodeSearchHit {
    const repository = query.workspace.repositories.find((item) => item.id === repositoryId)!;
    return {
      rank: rank + 1,
      providerRank: rank + 1,
      repositoryId,
      repositoryName: repository.name,
      path,
      symbol,
      startLine: 1,
      endLine: 2,
      preview: `export const ${symbol} = true;`,
      retrievalMethods: [query.mode],
      reference: { provider: this.name, opaqueId: `${repositoryId}:${path}:1`, repositoryId, path, startLine: 1, endLine: 2 },
      provenance: {
        provider: this.identity,
        workspaceId: query.workspace.id,
        repositoryId,
        requestedMode: query.mode,
        actualMode: query.mode,
        query: query.text,
        retrievedAt: "2026-07-27T00:00:00.000Z",
        indexState: "ready",
        indexedRevision: `${sourceRevisionIdentity(repository.snapshot)}:${this.indexRevision}`,
        currentRevision: `${sourceRevisionIdentity(repository.snapshot)}:${this.indexRevision}`,
        requestedFilters: {},
        enforcedFilters: [],
        postProcessing: [],
        reranked: false,
      },
    };
  }
}

function workspace(root: string): CodeWorkspace {
  return {
    id: "self-hosting-workspace",
    name: "self-hosting-workspace",
    roots: [root, join(root, "docs-repository")],
    repositories: [
      {
        id: "atelier",
        name: "atelier",
        root,
        snapshot: {
          repositoryId: "atelier-repository",
          workspaceId: "self-hosting-workspace",
          vcs: "jj",
          headCommit: "commit-1",
          changeId: "change-1",
          operationId: "operation-1",
          dirtyGeneration: 0,
          dirtyFingerprint: "clean-1",
          indexSchemaVersion: 1,
        },
      },
      {
        id: "docs",
        name: "docs",
        root: join(root, "docs-repository"),
        snapshot: {
          repositoryId: "docs-repository",
          workspaceId: "self-hosting-workspace",
          vcs: "git",
          headCommit: "docs-1",
          dirtyGeneration: 0,
          dirtyFingerprint: "docs-clean",
          indexSchemaVersion: 1,
        },
      },
    ],
  };
}

test("self-hosting planning stays within eight intelligence calls without stale or cross-scope evidence", async () => {
  const scenario = JSON.parse(readFileSync("evaluation/fixtures/self-hosting-retrieval-economy.json", "utf8")) as Scenario;
  const expectedPaths = new Set(Object.values(scenario.expectedPathGroups).flat());
  assert.ok(expectedPaths.has("packages/core/src/code/service.ts"));
  assert.ok(expectedPaths.has("tests/working-state-retrieval-persistence.test.ts"));
  assert.ok(expectedPaths.has("apps/pi-extension/src/index.ts"));
  assert.ok(expectedPaths.has("scripts/evaluate-code.ts"));
  assert.ok(expectedPaths.has("docs/CODESEARCH_EVALUATION.md"));

  const root = createTemporaryRepository("atlr-self-hosting-retrieval-");
  const ledgerPath = join(root, ".atelier", "self-hosting.db");
  const provider = new SelfHostingProvider();
  const work = workspace(root);
  let repositoryIntelligenceCalls = 0;
  let ledger = new SqliteLedger(ledgerPath);
  let code = new CodeService(new CodeProviderRegistry([provider], provider.name), ledger, {
    maxProviderRequests: scenario.budgets.maxProviderCalls,
    maxUniquePaths: 20,
    maxEvidenceEntries: 30,
  }, "self-hosting-session");
  let builder = new WorkingStateBuilder(new InMemoryTaskProvider(), ledger, code);

  try {
    ledger.setState("planObjective", scenario.objective);
    const first = await builder.build({ mode: "plan", snapshot: work.repositories[0]!.snapshot, workspace: work });
    repositoryIntelligenceCalls += 1;
    assert.equal(first.retrievalQueries[0]?.purpose, "plan_objective");
    assert.equal(provider.searchCalls.length, 1);

    repositoryIntelligenceCalls += 1;
    await builder.build({ mode: "plan", snapshot: work.repositories[0]!.snapshot, workspace: work });
    assert.equal(provider.symbolCalls.length, 1, "only the unresolved identifier should reach symbol lookup");
    await builder.build({ mode: "plan", snapshot: work.repositories[0]!.snapshot, workspace: work });
    assert.equal(provider.searchCalls.length, 1, "repeated Working State must consult the current inventory");
    assert.equal(provider.symbolCalls.length, 1, "resolved symbols must not be dispatched again");

    const discovery = first.retrievalQueries[0]!;
    const equivalentText = discovery.text.normalize("NFKC").replaceAll(" ", "\u00a0");
    repositoryIntelligenceCalls += 1;
    const equivalent = await code.search({
      workspace: work,
      text: equivalentText,
      mode: "semantic",
      focus: discovery.focus === "mixed" ? "all" : discovery.focus,
      literalHints: discovery.literalHints,
      limit: 6,
    });
    assert.equal(provider.searchCalls.length, 1, "Unicode and whitespace normalization must reuse the canonical query");
    assert.equal(code.retrievalStatus().lastDecision?.kind, "exact_reuse");
    assert.ok(equivalent.every((hit) => hit.provenance.provider.name === provider.name));

    repositoryIntelligenceCalls += 1;
    const direct = await code.search({ workspace: work, text: "packages/core/src/code/service.ts", limit: 5 });
    assert.equal(code.retrievalStatus().lastDecision?.kind, "direct_read");
    assert.deepEqual(new Set(direct.map((hit) => hit.path)), new Set(["packages/core/src/code/service.ts"]));

    repositoryIntelligenceCalls += 1;
    const atelier = await code.search({ workspace: work, text: "scoped evidence", repositoryIds: ["atelier"], limit: 10 });
    repositoryIntelligenceCalls += 1;
    const docs = await code.search({ workspace: work, text: "scoped evidence", repositoryIds: ["docs"], limit: 10 });
    assert.ok(atelier.every((hit) => hit.repositoryId === "atelier"));
    assert.ok(docs.every((hit) => hit.repositoryId === "docs"));

    await code.close();
    ledger.close();
    ledger = new SqliteLedger(ledgerPath);
    code = new CodeService(new CodeProviderRegistry([provider], provider.name), ledger, {
      maxProviderRequests: scenario.budgets.maxProviderCalls,
      maxUniquePaths: 20,
      maxEvidenceEntries: 30,
    }, "self-hosting-session");
    builder = new WorkingStateBuilder(new InMemoryTaskProvider(), ledger, code);
    const reopened = await builder.build({ mode: "plan", snapshot: work.repositories[0]!.snapshot, workspace: work });
    assert.equal(provider.searchCalls.length, 3, "bounded restart must reuse current persisted evidence");

    work.repositories[0]!.snapshot.dirtyGeneration = 1;
    work.repositories[0]!.snapshot.dirtyFingerprint = "dirty-2";
    repositoryIntelligenceCalls += 1;
    await code.search({ workspace: work, text: "scoped evidence", repositoryIds: ["atelier"], limit: 10 });
    assert.equal(code.retrievalStatus().lastDecision?.kind, "invalidated");
    assert.ok(code.retrievalStatus().evidence.every((item) => item.provenance.every((entry) =>
      entry.repositoryId !== "atelier"
      || entry.currentRevision?.includes(":dirty-2:") === true
      || entry.freshness !== "current")));

    provider.indexRevision = "index-2";
    repositoryIntelligenceCalls += 1;
    await code.search({ workspace: work, text: "scoped evidence", repositoryIds: ["atelier"], limit: 10 });
    const status = code.retrievalStatus();
    assert.equal(status.lastDecision?.kind, "invalidated");
    assert.ok(status.invalidations.some((item) => item.kind === "repository_revision"));
    assert.ok(status.invalidations.some((item) => item.kind === "index_revision"));
    assert.ok(status.evidence.every((item) => item.provenance.every((entry) => entry.currentRevision?.endsWith(":index-2") === true || entry.freshness !== "current")));
    assert.ok(status.telemetry.duplicateResultsRemoved >= scenario.expectedOutcome.duplicateIdentitiesRemovedMinimum);
    assert.equal(status.telemetry.uniquePaths, scenario.expectedOutcome.uniquePaths, "repeated paths must consume one unique-path slot");
    assert.ok(status.telemetry.bytesReturned >= 1);
    assert.equal(status.telemetry.truncated, scenario.expectedOutcome.truncation);
    assert.ok(status.telemetry.invalidations >= scenario.expectedOutcome.invalidationsMinimum);
    assert.equal(repositoryIntelligenceCalls, scenario.expectedOutcome.agentToolCalls);
    assert.equal(provider.searchCalls.length, 5);
    assert.equal(provider.symbolCalls.length, 1);
    assert.equal(status.telemetry.providerCalls, scenario.expectedOutcome.providerCalls);
    assert.ok(status.telemetry.cacheHits >= scenario.expectedOutcome.cacheHits);
    assert.ok(repositoryIntelligenceCalls <= scenario.budgets.maxRepositoryIntelligenceCalls, `${repositoryIntelligenceCalls} calls exceeded the fixture budget`);
    assert.ok(status.telemetry.providerCalls <= scenario.budgets.maxProviderCalls);
  } finally {
    await code.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
