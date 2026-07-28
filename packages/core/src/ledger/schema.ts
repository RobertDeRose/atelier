import type { SqliteDatabase } from "./sqlite-runtime.ts";
import { nowIso } from "../util/ids.ts";

/** Apply idempotent ledger schema migrations before repository state is read. */
export function migrateLedgerSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      task_id TEXT,
      repository_snapshot_json TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_events_kind_time
      ON ledger_events(kind, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS ledger_events_task_time
      ON ledger_events(task_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permission_grants (
      id TEXT PRIMARY KEY,
      execution_grant_id TEXT,
      permission TEXT NOT NULL,
      scope TEXT NOT NULL,
      actor TEXT NOT NULL,
      task_id TEXT,
      repository_id TEXT,
      paths_json TEXT,
      command_prefix_json TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_task_mappings (
      plan_task_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_task_id TEXT NOT NULL UNIQUE,
      plan_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(1, nowIso());

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_status_time
      ON workflow_runs(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS manual_edits (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS manual_edits_workflow_time
      ON manual_edits(workflow_run_id, updated_at DESC);
  `);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(2, nowIso());

  database.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      serialized_bytes INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retrieval_sessions_status_time
      ON retrieval_sessions(status, updated_at, id);

    CREATE TABLE IF NOT EXISTS retrieval_requests (
      session_id TEXT NOT NULL,
      query_digest TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      serialized_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, query_digest),
      FOREIGN KEY(session_id) REFERENCES retrieval_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS retrieval_evidence (
      session_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_json TEXT NOT NULL,
      serialized_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, evidence_digest),
      FOREIGN KEY(session_id) REFERENCES retrieval_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS retrieval_provenance (
      session_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      observation_index INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      serialized_bytes INTEGER NOT NULL,
      PRIMARY KEY(session_id, evidence_digest, observation_index),
      FOREIGN KEY(session_id, evidence_digest)
        REFERENCES retrieval_evidence(session_id, evidence_digest) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS retrieval_invalidations (
      session_id TEXT NOT NULL,
      diagnostic_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_json TEXT NOT NULL,
      serialized_bytes INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY(session_id, diagnostic_id),
      FOREIGN KEY(session_id) REFERENCES retrieval_sessions(id) ON DELETE CASCADE
    );
  `);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(3, nowIso());

  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_operations (
      reconciliation_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(reconciliation_digest, operation_id)
    );
    CREATE INDEX IF NOT EXISTS reconciliation_operations_status
      ON reconciliation_operations(reconciliation_digest, status, updated_at);
  `);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(4, nowIso());

  const permissionColumns = database.prepare("PRAGMA table_info(permission_grants)").all() as unknown as Array<{ name: string }>;
  if (!permissionColumns.some((column) => column.name === "execution_grant_id")) {
    database.exec("ALTER TABLE permission_grants ADD COLUMN execution_grant_id TEXT");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_approvals (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reconciliation_transactions (
      id TEXT PRIMARY KEY,
      plan_approval_id TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reconciliation_transactions_approval
      ON reconciliation_transactions(plan_approval_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_transactions_one_applying
      ON reconciliation_transactions(status) WHERE status = 'applying';
    CREATE TABLE IF NOT EXISTS execution_grants (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      task_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS execution_grants_one_active
      ON execution_grants(status) WHERE status = 'active';
  `);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(5, nowIso());

  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_evidence (
      id TEXT PRIMARY KEY,
      tool_call_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      task_id TEXT NOT NULL,
      execution_grant_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS execution_evidence_task_time
      ON execution_evidence(task_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS execution_evidence_grant_time
      ON execution_evidence(execution_grant_id, updated_at DESC);
  `);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(6, nowIso());

  const migration7 = database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version = 7").get() as
    | { present: number }
    | undefined;
  if (migration7 === undefined) {
    const timestamp = nowIso();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        UPDATE permission_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE scope NOT IN ('operation', 'task', 'repository')
      `).run(timestamp);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(7, timestamp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
