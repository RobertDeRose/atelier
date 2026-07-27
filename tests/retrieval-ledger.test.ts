import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type {
  CanonicalRetrievalQuery,
  PersistedRetrievalCheckpoint,
  PersistedRetrievalEvidence,
} from "../packages/core/src/code/retrieval.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { createTemporaryRepository } from "./fixtures.ts";

const query: CanonicalRetrievalQuery = {
  digest: "query-1",
  operation: "search",
  normalizedText: "working state",
  mode: "semantic",
  focus: "source",
  filters: {
    repositoryIds: ["repo"], languages: [], pathGlobs: [], literalHints: [], relationshipKinds: [],
    includeTests: true, includeGenerated: false,
  },
  binding: {
    workspaceId: "workspace",
    provider: { name: "fixture", version: "1", instanceId: "local" },
    indexRevision: "index-1",
    repositories: [{
      repositoryId: "repo", snapshotRepositoryId: "repo", workspaceId: "workspace", vcs: "git",
      headCommit: "commit-1", dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1,
    }],
  },
  requestedLimit: 5,
};

function evidence(index: number): PersistedRetrievalEvidence {
  return {
    digest: `evidence-${index}`,
    kind: "hit",
    queryDigests: [query.digest],
    value: {
      rank: index,
      repositoryId: "repo",
      repositoryName: "repo",
      path: `src/${index}.ts`,
      retrievalMethods: ["semantic"],
      reference: { provider: "fixture", opaqueId: `ref-${index}`, repositoryId: "repo", path: `src/${index}.ts` },
    },
    provenance: [{
      provider: query.binding.provider,
      workspaceId: "workspace",
      repositoryId: "repo",
      requestedMode: "semantic",
      actualMode: "semantic",
      query: "working state",
      retrievedAt: `2026-01-01T00:00:0${index}.000Z`,
      indexState: "ready",
      requestedFilters: {}, enforcedFilters: [], postProcessing: [], reranked: false,
      freshness: "current",
    }],
  };
}

function checkpoint(sessionId: string, updatedAt: string, entries = 1): PersistedRetrievalCheckpoint {
  const values = Array.from({ length: entries }, (_, index) => evidence(index + 1));
  return {
    sessionId,
    status: "active",
    startedAt: updatedAt,
    updatedAt,
    budget: {
      providerRequestsUsed: 1, providerRequestsLimit: 8,
      uniquePathsUsed: entries, uniquePathsLimit: 32,
      evidenceEntriesUsed: entries, evidenceEntriesLimit: 64,
      fetchesUsed: 0, fetchesLimit: 8,
      bytesUsed: 10, bytesLimit: 64_000,
    },
    telemetry: {
      providerCalls: 1, cacheHits: 0, overlapReuses: 0, uniquePaths: entries,
      duplicateResultsRemoved: 0, duplicatePathsRemoved: 0, duplicateSymbolsRemoved: 0, duplicateChunksRemoved: 0,
      duplicateReferencesRemoved: 0, bytesReturned: 10, truncated: false, invalidations: 0,
    },
    requests: [{
      query,
      requestDigest: "request-1",
      evidenceDigests: values.map((item) => item.digest),
      coveredLimit: 5,
      complete: true,
      truncated: false,
      degraded: false,
      freshness: "current",
      decision: { kind: "provider_call", reason: "fixture" },
    }],
    evidence: values,
    invalidations: [],
    diagnostics: [],
    decisions: [{
      queryDigest: query.digest,
      operation: "search",
      workspaceId: "workspace",
      repositoryIds: ["repo"],
      decision: { kind: "provider_call", reason: "fixture" },
      decidedAt: updatedAt,
    }],
  };
}

const persistenceLimits = { maxRetainedSessions: 2, maxEntries: 3, maxBytes: 100_000 };

test("version-two ledgers migrate retrieval inventory in place without altering existing state", () => {
  const root = createTemporaryRepository("atlr-retrieval-migration-");
  const path = join(root, ".atelier", "legacy.db");
  const ledger = new SqliteLedger(path);
  ledger.setState("approvedPlanHash", "preserved");
  ledger.setTaskMapping("ATLR-1", "beads", "task-1", "plan-hash");
  ledger.database.exec(`
    INSERT INTO permission_grants(
      id, permission, scope, actor, reason, created_at
    ) VALUES ('grant-1', 'repository.read', 'session', 'user', 'preserve', 'before');
    INSERT INTO workflow_runs(id, status, checkpoint, record_json, updated_at)
    VALUES ('workflow-1', 'active', 'review_pending', '{}', 'before');
    INSERT INTO manual_edits(id, workflow_run_id, status, record_json, updated_at)
    VALUES ('edit-1', 'workflow-1', 'completed', '{}', 'before');
    CREATE TABLE IF NOT EXISTS validation_evidence(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, command_json TEXT NOT NULL,
      snapshot_fingerprint TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, exit_code INTEGER NOT NULL, status TEXT NOT NULL,
      stdout TEXT NOT NULL, stderr TEXT NOT NULL
    );
    INSERT INTO validation_evidence VALUES(
      'validation-1', 'check', '["check"]', 'clean', 'before', 'before', 1, 0, 'passed', '', ''
    );
  `);
  ledger.database.prepare("DELETE FROM schema_migrations WHERE version IN (3, 4, 5, 6)").run();
  ledger.database.exec("DROP TABLE IF EXISTS retrieval_provenance; DROP TABLE IF EXISTS retrieval_evidence; DROP TABLE IF EXISTS retrieval_requests; DROP TABLE IF EXISTS retrieval_invalidations; DROP TABLE IF EXISTS retrieval_sessions; DROP TABLE IF EXISTS reconciliation_operations; DROP TABLE IF EXISTS plan_approvals; DROP TABLE IF EXISTS reconciliation_transactions; DROP TABLE IF EXISTS execution_grants; DROP TABLE IF EXISTS execution_evidence;");
  ledger.close();

  const reopened = new SqliteLedger(path);
  try {
    assert.equal(reopened.getState("approvedPlanHash"), "preserved");
    assert.equal(reopened.getTaskMapping("ATLR-1")?.providerTaskId, "task-1");
    assert.equal(reopened.listGrants().length, 1);
    assert.equal((reopened.database.prepare("SELECT COUNT(*) AS count FROM manual_edits").get() as { count: number }).count, 1);
    assert.equal((reopened.database.prepare("SELECT COUNT(*) AS count FROM validation_evidence").get() as { count: number }).count, 1);
    const versions = reopened.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
    reopened.saveRetrievalCheckpoint(checkpoint("session-a", "2026-01-01T00:00:00.000Z"), persistenceLimits);
    assert.equal(reopened.loadRetrievalCheckpoint("session-a")?.evidence.length, 1);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrieval result and request checkpoint persist atomically and corrupted or disappeared evidence is not current", () => {
  const root = createTemporaryRepository("atlr-retrieval-atomic-");
  const ledger = new SqliteLedger(join(root, ".atelier", "state.db"));
  try {
    ledger.saveRetrievalCheckpoint(checkpoint("atomic", "2026-01-01T00:00:00.000Z"), persistenceLimits);
    const circular = checkpoint("atomic", "2026-01-01T00:00:01.000Z", 2);
    (circular.diagnostics as unknown[]).push(circular);
    assert.throws(() => ledger.saveRetrievalCheckpoint(circular, persistenceLimits));
    assert.equal(ledger.loadRetrievalCheckpoint("atomic")?.evidence.length, 1, "failed replacement must preserve the prior checkpoint");

    ledger.saveRetrievalCheckpoint(checkpoint("good", "2026-01-01T00:00:02.000Z", 2), persistenceLimits);
    ledger.database.prepare("DELETE FROM retrieval_evidence WHERE session_id = ? AND evidence_digest = ?").run("good", "evidence-1");
    const missing = ledger.loadRetrievalCheckpoint("good")!;
    assert.equal(missing.requests[0]?.complete, false);
    assert.equal(missing.requests[0]?.freshness, "unknown");
    assert.ok(missing.diagnostics.some((item) => item.code === "persisted_evidence_missing"));

    ledger.database.prepare("UPDATE retrieval_evidence SET record_json = 'not-json' WHERE session_id = ?").run("good");
    const corrupted = ledger.loadRetrievalCheckpoint("good")!;
    assert.equal(corrupted.evidence.length, 0);
    assert.ok(corrupted.diagnostics.some((item) => item.code === "persisted_evidence_corrupted"));
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrieval persistence deterministically bounds sessions, entries, and serialized bytes", () => {
  const root = createTemporaryRepository("atlr-retrieval-prune-");
  const ledger = new SqliteLedger(join(root, ".atelier", "state.db"));
  try {
    ledger.saveRetrievalCheckpoint(checkpoint("oldest", "2026-01-01T00:00:00.000Z", 2), persistenceLimits);
    ledger.saveRetrievalCheckpoint(checkpoint("middle", "2026-01-01T00:00:01.000Z", 2), persistenceLimits);
    ledger.saveRetrievalCheckpoint(checkpoint("current", "2026-01-01T00:00:02.000Z", 2), persistenceLimits);

    assert.equal(ledger.loadRetrievalCheckpoint("oldest"), undefined);
    assert.ok(ledger.loadRetrievalCheckpoint("current"));
    const counts = ledger.retrievalStorageStats();
    assert.ok(counts.sessions <= persistenceLimits.maxRetainedSessions);
    assert.ok(counts.entries <= persistenceLimits.maxEntries);
    assert.ok(counts.bytes <= persistenceLimits.maxBytes);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
