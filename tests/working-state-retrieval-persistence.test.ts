import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AtelierCore,
  CodeProviderRegistry,
  CodeService,
  InMemoryTaskProvider,
  MockCodeProvider,
  SqliteLedger,
  WorkingStateBuilder,
  type CodeWorkspace,
} from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

class CountingProvider extends MockCodeProvider {
  searchCalls = 0;
  override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
    this.searchCalls += 1;
    return super.search(query);
  }
}

function provider(root: string) {
  return new CountingProvider([
    {
      repositoryId: "repo", repositoryName: "repo", root,
      path: "packages/core/src/state/working-state-builder.ts",
      symbol: "WorkingStateBuilder",
      content: "export class WorkingStateBuilder { compactEvidenceInventory = true; }",
    },
    {
      repositoryId: "repo", repositoryName: "repo", root,
      path: "packages/core/src/state/working-state-builder.ts",
      symbol: "WorkingStateBuilderDuplicate",
      content: "duplicate path must not consume the path budget twice",
    },
  ]);
}

test("a fresh Core reconstructs a bounded current retrieval session after compaction", async () => {
  const root = createTemporaryRepository("atlr-working-state-reopen-");
  const codeProvider = provider(root);
  const first = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "pi-session-a" });
  try {
    first.initialize();
    await codeProvider.ensureIndex(first.codeWorkspace());
    first.beginPlan("Update `WorkingStateBuilder` compactEvidenceInventory");
    const initial = await first.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 1);
    assert.equal(initial.retrievalSession?.id, "pi-session-a");
    assert.equal(initial.retrievalSession?.inventory.length, 1);
    const completed = first.ledger.listEvents({ kind: "code.search_completed", limit: 1 })[0]?.payload as
      | { telemetry?: Record<string, unknown> }
      | undefined;
    assert.equal(completed?.telemetry?.providerCalls, 1);
    assert.equal(typeof completed?.telemetry?.cacheHits, "number");
    assert.equal(typeof completed?.telemetry?.uniquePaths, "number");
    assert.equal(typeof completed?.telemetry?.duplicateResultsRemoved, "number");
    assert.equal(typeof completed?.telemetry?.bytesReturned, "number");
    assert.equal(typeof completed?.telemetry?.truncated, "boolean");
  } finally {
    first.close();
  }

  const reopened = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "pi-session-a" });
  try {
    const reconstructed = await reopened.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 1, "valid persisted evidence should satisfy the repeated build");
    assert.ok((reconstructed.retrievalSession?.telemetry.cacheHits ?? 0) >= 1);
    assert.equal(reconstructed.retrievalSession?.inventory.length, 1);
    assert.match(reopened.workingStateBuilder.toMarkdown(reconstructed), /## Retrieval session/);
    assert.match(reopened.workingStateBuilder.toMarkdown(reconstructed), /Provider calls: 1/);
    assert.ok(reconstructed.retrievalSession?.decisions.some((item) => item.decision.kind === "exact_reuse"));

    await codeProvider.ensureIndex(reopened.codeWorkspace());
    const reindexed = await reopened.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 2);
    assert.ok(reindexed.retrievalSession?.invalidations.some((item) => item.kind === "index_revision"));
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new sessions do not reuse old evidence and repository drift invalidates current evidence immediately", async () => {
  const root = createTemporaryRepository("atlr-working-state-invalidate-");
  const codeProvider = provider(root);
  const first = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "old-session" });
  try {
    first.initialize();
    await codeProvider.ensureIndex(first.codeWorkspace());
    first.beginPlan("Update `WorkingStateBuilder` compactEvidenceInventory");
    await first.buildWorkingState();
  } finally { first.close(); }

  const different = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "new-session" });
  try {
    const fresh = await different.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 2);
    assert.equal(fresh.retrievalSession?.id, "new-session");
    assert.equal(different.ledger.loadRetrievalCheckpoint("old-session")?.status, "closed");

    writeFileSync(join(root, "changed.txt"), "repository drift\n", "utf8");
    const invalidated = await different.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 3);
    assert.ok((invalidated.retrievalSession?.telemetry.invalidations ?? 0) >= 1);
    assert.ok(invalidated.retrievalSession?.decisions.some((item) => item.decision.kind === "invalidated"));
    assert.ok(invalidated.retrievalSession?.inventory.every((item) => item.freshness !== "current") === false);
  } finally {
    different.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider outage and unknown freshness cannot report persisted evidence as current", async () => {
  const root = createTemporaryRepository("atlr-working-state-freshness-");
  class FreshnessProvider extends CountingProvider {
    unavailable = false;
    unknownRevision = false;
    override async status() {
      const status = await super.status();
      if (this.unknownRevision) {
        const { indexRevision: _indexRevision, ...withoutRevision } = status;
        return { ...withoutRevision, capabilities: withoutRevision.capabilities.filter((item) => item !== "index.revision_aware") };
      }
      return this.unavailable ? { ...status, available: false, healthy: false } : status;
    }
    override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
      if (this.unavailable) {
        this.searchCalls += 1;
        throw new Error("provider outage");
      }
      return super.search(query);
    }
  }
  const codeProvider = new FreshnessProvider([{
    repositoryId: "repo", repositoryName: "repo", root,
    path: "src/freshness.ts", content: "export const persistedFreshness = true;",
  }]);
  const first = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "freshness-session" });
  try {
    first.initialize();
    await codeProvider.ensureIndex(first.codeWorkspace());
    first.beginPlan("Inspect persistedFreshness");
    await first.buildWorkingState();
  } finally { first.close(); }

  codeProvider.unavailable = true;
  const outage = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "freshness-session" });
  try {
    const state = await outage.buildWorkingState();
    assert.equal(state.retrievalSession?.inventory.length, 0);
    assert.ok(state.omissions.some((item) => item.includes("Code provider unavailable")));
    assert.ok(state.retrievalSession?.invalidations.length);
  } finally { outage.close(); }

  codeProvider.unavailable = false;
  codeProvider.unknownRevision = true;
  const unknown = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "unknown-session" });
  try {
    await unknown.buildWorkingState();
    await unknown.buildWorkingState();
    assert.ok((unknown.code.retrievalStatus().telemetry.providerCalls ?? 0) >= 2);
    assert.ok(unknown.code.retrievalStatus().evidence.every((item) => item.provenance[0]?.freshness === "unknown"));
  } finally {
    unknown.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Working State compact inventory never leaks across workspace or repository scopes", async () => {
  const root = createTemporaryRepository("atlr-working-state-scope-");
  const codeProvider = new CountingProvider([
    { repositoryId: "a", repositoryName: "a", root, path: "src/a.ts", content: "export const scopedEvidence = 'a';" },
    { repositoryId: "b", repositoryName: "b", root, path: "src/b.ts", content: "export const scopedEvidence = 'b';" },
  ]);
  const ledger = new SqliteLedger(join(root, ".atelier", "scope.db"));
  const code = new CodeService(new CodeProviderRegistry([codeProvider], codeProvider.name), ledger, {}, "scope-session");
  const builder = new WorkingStateBuilder(new InMemoryTaskProvider(), ledger, code);
  const scopedWorkspace = (id: string, repositoryId: string): CodeWorkspace => ({
    id,
    name: id,
    roots: [root],
    repositories: [{
      id: repositoryId,
      name: repositoryId,
      root,
      snapshot: {
        repositoryId,
        workspaceId: id,
        vcs: "git",
        headCommit: `${repositoryId}-commit`,
        dirtyGeneration: 0,
        dirtyFingerprint: "clean",
        indexSchemaVersion: 1,
      },
    }],
  });
  const workspaceA = scopedWorkspace("workspace-a", "a");
  const workspaceB = scopedWorkspace("workspace-b", "b");
  try {
    ledger.setState("planObjective", "Inspect scopedEvidence");
    await codeProvider.ensureIndex(workspaceA);
    const stateA = await builder.build({ mode: "plan", snapshot: workspaceA.repositories[0]!.snapshot, workspace: workspaceA });
    assert.deepEqual(new Set(stateA.retrievalSession?.inventory.map((item) => item.repositoryId)), new Set(["a"]));

    await codeProvider.ensureIndex(workspaceB);
    const stateB = await builder.build({ mode: "plan", snapshot: workspaceB.repositories[0]!.snapshot, workspace: workspaceB });
    assert.deepEqual(new Set(stateB.retrievalSession?.inventory.map((item) => item.repositoryId)), new Set(["b"]));
    assert.ok(stateB.codeEvidence.every((item) => item.repositoryId === "b"));
  } finally {
    await code.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed provider calls never become successful persisted requests", async () => {
  const root = createTemporaryRepository("atlr-working-state-failed-call-");
  class FailingCodeProvider extends CountingProvider {
    fail = true;
    override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
      this.searchCalls += 1;
      if (this.fail) throw new Error("interrupted provider call");
      return MockCodeProvider.prototype.search.call(this, query);
    }
  }
  const codeProvider = new FailingCodeProvider([]);
  const first = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "failed-session" });
  try {
    first.initialize();
    await codeProvider.ensureIndex(first.codeWorkspace());
    first.beginPlan("Investigate interrupted provider call");
    const degraded = await first.buildWorkingState();
    assert.ok(degraded.omissions.some((item) => item.includes("interrupted provider call")));
    assert.equal(first.ledger.loadRetrievalCheckpoint("failed-session")?.requests.length ?? 0, 0);
  } finally { first.close(); }

  codeProvider.fail = false;
  const reopened = AtelierCore.open(root, { taskProvider: "memory", codeProvider, retrievalSessionId: "failed-session" });
  try {
    await reopened.buildWorkingState();
    assert.equal(codeProvider.searchCalls, 2);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
