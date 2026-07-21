import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Actor, LedgerEvent, PermissionGrant, RepositorySnapshot } from "../domain/types.ts";
import { newId, nowIso } from "../util/ids.ts";

interface EventRow {
  id: string;
  kind: string;
  occurred_at: string;
  actor: Actor;
  task_id: string | null;
  repository_snapshot_json: string | null;
  payload_json: string;
}

interface PermissionRow {
  id: string;
  permission: PermissionGrant["permission"];
  scope: PermissionGrant["scope"];
  actor: Actor;
  task_id: string | null;
  repository_id: string | null;
  paths_json: string | null;
  command_prefix_json: string | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export class SqliteLedger {
  readonly path: string;
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
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

    this.database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(1, nowIso());
  }

  append<TPayload>(input: {
    kind: string;
    actor: Actor;
    taskId?: string;
    repositorySnapshot?: RepositorySnapshot;
    payload: TPayload;
  }): LedgerEvent<TPayload> {
    const event: LedgerEvent<TPayload> = {
      id: newId("evt"),
      kind: input.kind,
      occurredAt: nowIso(),
      actor: input.actor,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.repositorySnapshot === undefined ? {} : { repositorySnapshot: input.repositorySnapshot }),
      payload: input.payload,
    };

    this.database
      .prepare(`
        INSERT INTO ledger_events(
          id, kind, occurred_at, actor, task_id, repository_snapshot_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.kind,
        event.occurredAt,
        event.actor,
        event.taskId ?? null,
        event.repositorySnapshot === undefined ? null : JSON.stringify(event.repositorySnapshot),
        JSON.stringify(event.payload),
      );
    return event;
  }

  listEvents(options: { kind?: string; taskId?: string; limit?: number } = {}): LedgerEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 100);
    const rows = this.database
      .prepare(`SELECT * FROM ledger_events ${where} ORDER BY occurred_at DESC LIMIT ?`)
      .all(...params) as unknown as EventRow[];
    return rows.map((row) => this.eventFromRow(row));
  }

  private eventFromRow(row: EventRow): LedgerEvent {
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      actor: row.actor,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.repository_snapshot_json === null
        ? {}
        : { repositorySnapshot: JSON.parse(row.repository_snapshot_json) as RepositorySnapshot }),
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  setState<T>(key: string, value: T): void {
    this.database
      .prepare(`
        INSERT INTO state(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), nowIso());
  }

  getState<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM state WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value_json) as T);
  }

  saveGrant(grant: PermissionGrant): void {
    this.database
      .prepare(`
        INSERT INTO permission_grants(
          id, permission, scope, actor, task_id, repository_id, paths_json,
          command_prefix_json, reason, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          permission = excluded.permission,
          scope = excluded.scope,
          actor = excluded.actor,
          task_id = excluded.task_id,
          repository_id = excluded.repository_id,
          paths_json = excluded.paths_json,
          command_prefix_json = excluded.command_prefix_json,
          reason = excluded.reason,
          expires_at = excluded.expires_at,
          revoked_at = excluded.revoked_at
      `)
      .run(
        grant.id,
        grant.permission,
        grant.scope,
        grant.actor,
        grant.taskId ?? null,
        grant.repositoryId ?? null,
        grant.paths === undefined ? null : JSON.stringify(grant.paths),
        grant.commandPrefix === undefined ? null : JSON.stringify(grant.commandPrefix),
        grant.reason,
        grant.createdAt,
        grant.expiresAt ?? null,
        grant.revokedAt ?? null,
      );
  }

  revokeGrant(id: string, revokedAt = nowIso()): boolean {
    const result = this.database
      .prepare("UPDATE permission_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(revokedAt, id);
    return Number(result.changes) > 0;
  }

  listGrants(options: { includeRevoked?: boolean } = {}): PermissionGrant[] {
    const rows = this.database
      .prepare(`SELECT * FROM permission_grants ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at`)
      .all() as unknown as PermissionRow[];
    return rows.map((row) => ({
      id: row.id,
      permission: row.permission,
      scope: row.scope,
      actor: row.actor,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.repository_id === null ? {} : { repositoryId: row.repository_id }),
      ...(row.paths_json === null ? {} : { paths: JSON.parse(row.paths_json) as string[] }),
      ...(row.command_prefix_json === null
        ? {}
        : { commandPrefix: JSON.parse(row.command_prefix_json) as string[] }),
      reason: row.reason,
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }));
  }

  setTaskMapping(planTaskId: string, provider: string, providerTaskId: string, planHash: string): void {
    this.database
      .prepare(`
        INSERT INTO plan_task_mappings(plan_task_id, provider, provider_task_id, plan_hash, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plan_task_id) DO UPDATE SET
          provider = excluded.provider,
          provider_task_id = excluded.provider_task_id,
          plan_hash = excluded.plan_hash,
          updated_at = excluded.updated_at
      `)
      .run(planTaskId, provider, providerTaskId, planHash, nowIso());
  }

  getTaskMapping(planTaskId: string): { provider: string; providerTaskId: string; planHash: string } | undefined {
    const row = this.database
      .prepare("SELECT provider, provider_task_id, plan_hash FROM plan_task_mappings WHERE plan_task_id = ?")
      .get(planTaskId) as
      | { provider: string; provider_task_id: string; plan_hash: string }
      | undefined;
    return row === undefined
      ? undefined
      : { provider: row.provider, providerTaskId: row.provider_task_id, planHash: row.plan_hash };
  }

  listTaskMappings(): Array<{ planTaskId: string; provider: string; providerTaskId: string; planHash: string }> {
    const rows = this.database
      .prepare("SELECT plan_task_id, provider, provider_task_id, plan_hash FROM plan_task_mappings ORDER BY plan_task_id")
      .all() as unknown as Array<{
      plan_task_id: string;
      provider: string;
      provider_task_id: string;
      plan_hash: string;
    }>;
    return rows.map((row) => ({
      planTaskId: row.plan_task_id,
      provider: row.provider,
      providerTaskId: row.provider_task_id,
      planHash: row.plan_hash,
    }));
  }

  close(): void {
    this.database.close();
  }
}
