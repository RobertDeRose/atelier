import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadDatabaseSync, type SqliteDatabase } from "./sqlite-runtime.ts";
import { migrateLedgerSchema } from "./schema.ts";
import type {
  Actor,
  ExecutionEvidence,
  ExecutionGrant,
  ExecutionPause,
  LedgerEvent,
  ManualEdit,
  PermissionGrant,
  PlanApproval,
  ReconciliationOperationCheckpoint,
  ReconciliationTransaction,
  RepositorySnapshot,
  WorkflowCheckpoint,
  WorkflowRun,
} from "../domain/types.ts";
import type {
  PersistedRetrievalCheckpoint,
  PersistedRetrievalEvidence,
  PersistedRetrievalRequest,
  RetrievalDiagnostic,
  RetrievalPersistenceLimits,
} from "../code/retrieval.ts";
import { newId, nowIso } from "../util/ids.ts";
import { redactValue } from "../security/redaction.ts";
import {
  normalizeExecutionGrant,
  normalizePlanApproval,
  validatePersistenceLimits,
  type EventRow,
  type ManualEditRow,
  type PermissionRow,
  type WorkflowRunRow,
} from "./ledger-records.ts";

export class SqliteLedger {
  readonly path: string;
  readonly database: SqliteDatabase;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrateLedgerSchema(this.database);
  }

  append<TPayload>(input: {
    kind: string;
    actor: Actor;
    taskId?: string;
    repositorySnapshot?: RepositorySnapshot;
    payload: TPayload;
  }): LedgerEvent<TPayload> {
    const event = this.createEvent(input);
    this.insertEvent(event);
    return event;
  }

  saveWorkflowTransition<TPayload>(input: {
    run: WorkflowRun;
    manualEdit?: ManualEdit;
    event: {
      kind: string;
      actor: Actor;
      taskId?: string;
      repositorySnapshot?: RepositorySnapshot;
      payload: TPayload;
    };
    stateUpdates?: Record<string, unknown>;
    clearStateKeys?: string[];
  }): LedgerEvent<TPayload> {
    const event = this.createEvent(input.event);
    const runJson = JSON.stringify(input.run);
    const manualEditJson = input.manualEdit === undefined
      ? undefined
      : JSON.stringify(input.manualEdit);
    const stateUpdates = Object.entries(input.stateUpdates ?? {}).map(([key, value]) => [
      key,
      JSON.stringify(value),
    ] as const);
    const timestamp = input.run.updatedAt;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO workflow_runs(id, status, checkpoint, record_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          checkpoint = excluded.checkpoint,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `).run(input.run.id, input.run.status, input.run.checkpoint, runJson, timestamp);
      this.upsertState("currentWorkflowRunId", JSON.stringify(input.run.id), timestamp);

      if (input.manualEdit !== undefined && manualEditJson !== undefined) {
        this.database.prepare(`
          INSERT INTO manual_edits(id, workflow_run_id, status, record_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            workflow_run_id = excluded.workflow_run_id,
            status = excluded.status,
            record_json = excluded.record_json,
            updated_at = excluded.updated_at
        `).run(
          input.manualEdit.id,
          input.manualEdit.workflowRunId,
          input.manualEdit.status,
          manualEditJson,
          input.manualEdit.finishedAt ?? input.manualEdit.startedAt,
        );
        this.upsertState("currentManualEditId", JSON.stringify(input.manualEdit.id), timestamp);
      }

      for (const [key, valueJson] of stateUpdates) this.upsertState(key, valueJson, timestamp);
      for (const key of input.clearStateKeys ?? []) {
        this.database.prepare("DELETE FROM state WHERE key = ?").run(key);
      }
      this.insertEvent(event);
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkflowRun(id: string): WorkflowRun | undefined {
    const row = this.database.prepare("SELECT record_json FROM workflow_runs WHERE id = ?").get(id) as
      | WorkflowRunRow
      | undefined;
    return row == null ? undefined : JSON.parse(row.record_json) as WorkflowRun;
  }

  getCurrentWorkflowRun(): WorkflowRun | undefined {
    const id = this.getState<string>("currentWorkflowRunId");
    return id === undefined ? undefined : this.getWorkflowRun(id);
  }

  setWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): WorkflowRun | undefined {
    const current = this.getCurrentWorkflowRun();
    if (current === undefined || current.checkpoint === checkpoint) return current;
    const next: WorkflowRun = { ...current, checkpoint, updatedAt: nowIso() };
    this.database.prepare(`
      UPDATE workflow_runs SET checkpoint = ?, record_json = ?, updated_at = ? WHERE id = ?
    `).run(checkpoint, JSON.stringify(next), next.updatedAt, next.id);
    this.append({
      kind: "workflow.checkpoint_changed",
      actor: "system",
      payload: { workflowRunId: next.id, previous: current.checkpoint, checkpoint },
    });
    return next;
  }

  getManualEdit(id: string): ManualEdit | undefined {
    const row = this.database.prepare("SELECT record_json FROM manual_edits WHERE id = ?").get(id) as
      | ManualEditRow
      | undefined;
    return row == null ? undefined : JSON.parse(row.record_json) as ManualEdit;
  }

  getCurrentManualEdit(): ManualEdit | undefined {
    const id = this.getState<string>("currentManualEditId");
    return id === undefined ? undefined : this.getManualEdit(id);
  }

  listEvents(options: { kind?: string; kinds?: string[]; taskId?: string; limit?: number } = {}): LedgerEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind !== undefined && options.kinds !== undefined) {
      throw new Error("Specify either kind or kinds when reading ledger events, not both.");
    }
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.kinds !== undefined) {
      const kinds = [...new Set(options.kinds)].filter(Boolean);
      if (kinds.length === 0) return [];
      clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 100);
    const rows = this.database
      .prepare(`SELECT * FROM ledger_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
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
    this.upsertState(key, JSON.stringify(value), nowIso());
  }

  deleteState(key: string): boolean {
    const result = this.database.prepare("DELETE FROM state WHERE key = ?").run(key);
    return Number(result.changes) > 0;
  }

  getState<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM state WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row == null ? undefined : (JSON.parse(row.value_json) as T);
  }

  saveRetrievalCheckpoint(
    checkpoint: PersistedRetrievalCheckpoint,
    limits: RetrievalPersistenceLimits,
  ): void {
    validatePersistenceLimits(limits);
    const timestamp = checkpoint.updatedAt;
    const sessionRecord = {
      status: checkpoint.status,
      startedAt: checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt,
      budget: checkpoint.budget,
      telemetry: checkpoint.telemetry,
      ...(checkpoint.lastDecision === undefined ? {} : { lastDecision: checkpoint.lastDecision }),
      decisions: checkpoint.decisions,
    };
    const sessionJson = JSON.stringify(redactValue(sessionRecord));
    const requestRecords = [...checkpoint.requests]
      .sort((left, right) => left.query.digest.localeCompare(right.query.digest))
      .map((record) => ({ record, json: JSON.stringify(redactValue(record)) }));
    const evidenceRecords = [...checkpoint.evidence]
      .sort((left, right) => left.digest.localeCompare(right.digest))
      .map((record) => {
        const { provenance, ...compact } = record;
        return {
          record,
          json: JSON.stringify(redactValue(compact)),
          provenance: provenance.map((observation) => JSON.stringify(redactValue(observation))),
        };
      });
    const diagnosticRecords = [
      ...checkpoint.invalidations.map((record, index) => ({
        id: `invalidation:${index}:${record.invalidatedAt}`,
        kind: "invalidation",
        occurredAt: record.invalidatedAt,
        json: JSON.stringify(redactValue(record)),
      })),
      ...checkpoint.diagnostics.map((record, index) => ({
        id: `diagnostic:${index}:${checkpoint.updatedAt}`,
        kind: "diagnostic",
        occurredAt: checkpoint.updatedAt,
        json: JSON.stringify(redactValue(record)),
      })),
    ];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE retrieval_sessions SET status = 'closed'
        WHERE id <> ? AND status = 'active'
      `).run(checkpoint.sessionId);
      this.database.prepare(`
        INSERT INTO retrieval_sessions(id, status, record_json, serialized_bytes, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json,
          serialized_bytes = excluded.serialized_bytes,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `).run(
        checkpoint.sessionId,
        checkpoint.status,
        sessionJson,
        Buffer.byteLength(sessionJson),
        checkpoint.startedAt,
        timestamp,
      );
      for (const table of ["retrieval_requests", "retrieval_invalidations", "retrieval_evidence"] as const) {
        this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(checkpoint.sessionId);
      }

      let retainedEntries = 0;
      for (const item of requestRecords) {
        if (retainedEntries >= limits.maxEntries) break;
        this.database.prepare(`
          INSERT INTO retrieval_requests(
            session_id, query_digest, request_digest, status, record_json, serialized_bytes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpoint.sessionId,
          item.record.query.digest,
          item.record.requestDigest,
          item.record.complete ? "complete" : "incomplete",
          item.json,
          Buffer.byteLength(item.json),
          timestamp,
        );
        retainedEntries += 1;
      }
      for (const item of evidenceRecords) {
        if (retainedEntries >= limits.maxEntries) break;
        this.database.prepare(`
          INSERT INTO retrieval_evidence(
            session_id, evidence_digest, kind, record_json, serialized_bytes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          checkpoint.sessionId,
          item.record.digest,
          item.record.kind,
          item.json,
          Buffer.byteLength(item.json),
          timestamp,
        );
        item.provenance.forEach((json, index) => {
          this.database.prepare(`
            INSERT INTO retrieval_provenance(
              session_id, evidence_digest, observation_index, record_json, serialized_bytes
            ) VALUES (?, ?, ?, ?, ?)
          `).run(checkpoint.sessionId, item.record.digest, index, json, Buffer.byteLength(json));
        });
        retainedEntries += 1;
      }
      for (const item of diagnosticRecords.slice(-limits.maxEntries)) {
        this.database.prepare(`
          INSERT INTO retrieval_invalidations(
            session_id, diagnostic_id, kind, record_json, serialized_bytes, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          checkpoint.sessionId,
          item.id,
          item.kind,
          item.json,
          Buffer.byteLength(item.json),
          item.occurredAt,
        );
      }

      this.pruneRetrievalStorage(checkpoint.sessionId, limits);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  loadRetrievalCheckpoint(sessionId: string): PersistedRetrievalCheckpoint | undefined {
    const session = this.database.prepare("SELECT status, record_json FROM retrieval_sessions WHERE id = ?").get(sessionId) as
      | { status: PersistedRetrievalCheckpoint["status"]; record_json: string }
      | undefined;
    if (session === undefined) return undefined;
    let metadata: Omit<PersistedRetrievalCheckpoint, "sessionId" | "requests" | "evidence" | "invalidations" | "diagnostics">;
    try {
      metadata = JSON.parse(session.record_json) as typeof metadata;
    } catch {
      return undefined;
    }

    const diagnostics: RetrievalDiagnostic[] = [];
    const invalidations: PersistedRetrievalCheckpoint["invalidations"] = [];
    const diagnosticRows = this.database.prepare(`
      SELECT kind, record_json FROM retrieval_invalidations
      WHERE session_id = ? ORDER BY occurred_at, diagnostic_id
    `).all(sessionId) as unknown as Array<{ kind: string; record_json: string }>;
    for (const row of diagnosticRows) {
      try {
        if (row.kind === "invalidation") invalidations.push(JSON.parse(row.record_json) as PersistedRetrievalCheckpoint["invalidations"][number]);
        else diagnostics.push(JSON.parse(row.record_json) as RetrievalDiagnostic);
      } catch {
        diagnostics.push({ code: "persisted_diagnostic_corrupted", level: "warning", message: "A persisted retrieval diagnostic was corrupted and omitted." });
      }
    }

    const evidence = new Map<string, PersistedRetrievalEvidence>();
    const evidenceRows = this.database.prepare(`
      SELECT evidence_digest, record_json FROM retrieval_evidence
      WHERE session_id = ? ORDER BY evidence_digest
    `).all(sessionId) as unknown as Array<{ evidence_digest: string; record_json: string }>;
    for (const row of evidenceRows) {
      try {
        const compact = JSON.parse(row.record_json) as Omit<PersistedRetrievalEvidence, "provenance">;
        const provenanceRows = this.database.prepare(`
          SELECT record_json FROM retrieval_provenance
          WHERE session_id = ? AND evidence_digest = ? ORDER BY observation_index
        `).all(sessionId, row.evidence_digest) as unknown as Array<{ record_json: string }>;
        if (provenanceRows.length === 0) throw new Error("missing provenance");
        const provenance = provenanceRows.map((item) => JSON.parse(item.record_json) as PersistedRetrievalEvidence["provenance"][number]);
        evidence.set(row.evidence_digest, { ...compact, provenance });
      } catch {
        diagnostics.push({
          code: "persisted_evidence_corrupted",
          level: "warning",
          message: `Persisted evidence ${row.evidence_digest} was corrupted or incomplete and omitted.`,
        });
      }
    }

    const requestRows = this.database.prepare(`
      SELECT record_json FROM retrieval_requests WHERE session_id = ? ORDER BY query_digest
    `).all(sessionId) as unknown as Array<{ record_json: string }>;
    const requests: PersistedRetrievalRequest[] = [];
    for (const row of requestRows) {
      try {
        const request = JSON.parse(row.record_json) as PersistedRetrievalRequest;
        const missing = request.evidenceDigests.filter((digest) => !evidence.has(digest));
        if (missing.length > 0) {
          diagnostics.push({
            code: "persisted_evidence_missing",
            level: "warning",
            message: `Persisted request ${request.query.digest} lost ${missing.length} evidence record(s) and is not current.`,
            queryDigest: request.query.digest,
            providerCallRequired: true,
          });
          requests.push({ ...request, complete: false, freshness: "unknown" });
        } else requests.push(request);
      } catch {
        diagnostics.push({ code: "persisted_request_corrupted", level: "warning", message: "A persisted retrieval request was corrupted and omitted." });
      }
    }

    return {
      sessionId,
      ...metadata,
      status: session.status,
      requests,
      evidence: [...evidence.values()],
      invalidations,
      diagnostics,
    };
  }

  retrievalStorageStats(): { sessions: number; entries: number; bytes: number } {
    const sessions = this.scalarCount("SELECT COUNT(*) AS count FROM retrieval_sessions");
    const entries = this.scalarCount("SELECT COUNT(*) AS count FROM retrieval_requests")
      + this.scalarCount("SELECT COUNT(*) AS count FROM retrieval_evidence");
    const bytes = ["retrieval_sessions", "retrieval_requests", "retrieval_evidence", "retrieval_provenance", "retrieval_invalidations"]
      .reduce((total, table) => total + this.scalarCount(`SELECT COALESCE(SUM(serialized_bytes), 0) AS count FROM ${table}`), 0);
    return { sessions, entries, bytes };
  }

  private pruneRetrievalStorage(currentSessionId: string, limits: RetrievalPersistenceLimits): void {
    const sessions = this.database.prepare(`
      SELECT id FROM retrieval_sessions ORDER BY updated_at DESC, id DESC
    `).all() as unknown as Array<{ id: string }>;
    const retained = new Set([currentSessionId, ...sessions.filter((row) => row.id !== currentSessionId)
      .slice(0, Math.max(0, limits.maxRetainedSessions - 1)).map((row) => row.id)]);
    for (const row of sessions) if (!retained.has(row.id)) this.database.prepare("DELETE FROM retrieval_sessions WHERE id = ?").run(row.id);

    while (true) {
      const stats = this.retrievalStorageStats();
      if (stats.entries <= limits.maxEntries && stats.bytes <= limits.maxBytes) break;
      const inactive = this.database.prepare(`
        SELECT id FROM retrieval_sessions WHERE id <> ? ORDER BY updated_at, id LIMIT 1
      `).get(currentSessionId) as { id: string } | undefined;
      if (inactive !== undefined) {
        this.database.prepare("DELETE FROM retrieval_sessions WHERE id = ?").run(inactive.id);
        continue;
      }
      const evidence = this.database.prepare(`
        SELECT evidence_digest FROM retrieval_evidence
        WHERE session_id = ? ORDER BY updated_at, evidence_digest DESC LIMIT 1
      `).get(currentSessionId) as { evidence_digest: string } | undefined;
      if (evidence !== undefined) {
        this.database.prepare("DELETE FROM retrieval_evidence WHERE session_id = ? AND evidence_digest = ?")
          .run(currentSessionId, evidence.evidence_digest);
        continue;
      }
      const request = this.database.prepare(`
        SELECT query_digest FROM retrieval_requests
        WHERE session_id = ? ORDER BY updated_at, query_digest DESC LIMIT 1
      `).get(currentSessionId) as { query_digest: string } | undefined;
      if (request !== undefined) {
        this.database.prepare("DELETE FROM retrieval_requests WHERE session_id = ? AND query_digest = ?")
          .run(currentSessionId, request.query_digest);
        continue;
      }
      this.database.prepare(`
        DELETE FROM retrieval_invalidations WHERE session_id = ? AND diagnostic_id = (
          SELECT diagnostic_id FROM retrieval_invalidations WHERE session_id = ? ORDER BY occurred_at, diagnostic_id LIMIT 1
        )
      `).run(currentSessionId, currentSessionId);
      if (this.retrievalStorageStats().bytes > limits.maxBytes) {
        const compact = JSON.stringify({
          status: "active",
          startedAt: nowIso(),
          updatedAt: nowIso(),
          budget: {}, telemetry: {}, decisions: [],
        });
        this.database.prepare("UPDATE retrieval_sessions SET record_json = ?, serialized_bytes = ? WHERE id = ?")
          .run(compact, Buffer.byteLength(compact), currentSessionId);
      }
      break;
    }
  }

  private scalarCount(sql: string): number {
    const row = this.database.prepare(sql).get() as { count: number | bigint };
    return Number(row.count);
  }

  saveReconciliationCheckpoint(checkpoint: ReconciliationOperationCheckpoint): void {
    const event = this.createEvent({
      kind: `reconciliation.operation_${checkpoint.status}`,
      actor: "system",
      payload: checkpoint,
    });
    const record = JSON.stringify(checkpoint);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO reconciliation_operations(
          reconciliation_digest, operation_id, status, record_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(reconciliation_digest, operation_id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `).run(
        checkpoint.reconciliationDigest,
        checkpoint.operationId,
        checkpoint.status,
        record,
        checkpoint.updatedAt,
      );
      this.insertEvent(event);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listReconciliationCheckpoints(reconciliationDigest: string): ReconciliationOperationCheckpoint[] {
    const rows = this.database.prepare(`
      SELECT record_json FROM reconciliation_operations
      WHERE reconciliation_digest = ? ORDER BY operation_id
    `).all(reconciliationDigest) as unknown as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as ReconciliationOperationCheckpoint);
  }

  saveExecutionEvidence(evidence: ExecutionEvidence): void {
    const record = JSON.stringify(redactValue(evidence));
    this.database.prepare(`
      INSERT INTO execution_evidence(
        id, tool_call_id, status, task_id, execution_grant_id, record_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_call_id) DO UPDATE SET
        status = excluded.status,
        task_id = excluded.task_id,
        execution_grant_id = excluded.execution_grant_id,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(
      evidence.id,
      evidence.toolCallId,
      evidence.status,
      evidence.taskId,
      evidence.executionGrantId,
      record,
      evidence.finishedAt ?? evidence.startedAt,
    );
  }

  getExecutionEvidence(toolCallId: string): ExecutionEvidence | undefined {
    const row = this.database.prepare("SELECT record_json FROM execution_evidence WHERE tool_call_id = ?").get(toolCallId) as
      | { record_json: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.record_json) as ExecutionEvidence;
  }

  listExecutionEvidence(options: { taskId?: string; executionGrantId?: string; limit?: number } = {}): ExecutionEvidence[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      parameters.push(options.taskId);
    }
    if (options.executionGrantId !== undefined) {
      clauses.push("execution_grant_id = ?");
      parameters.push(options.executionGrantId);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    parameters.push(options.limit ?? 50);
    const rows = this.database.prepare(`
      SELECT record_json FROM execution_evidence ${where} ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...parameters) as unknown as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as ExecutionEvidence);
  }

  savePlanApproval(approval: PlanApproval): void {
    const record = JSON.stringify(approval);
    this.database.prepare(`
      INSERT INTO plan_approvals(id, status, record_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(approval.id, approval.status, record, approval.decidedAt ?? approval.preparedAt);
  }

  getPlanApproval(id: string): PlanApproval | undefined {
    const row = this.database.prepare("SELECT record_json FROM plan_approvals WHERE id = ?").get(id) as
      | { record_json: string }
      | undefined;
    return row === undefined ? undefined : normalizePlanApproval(row.record_json);
  }

  listPlanApprovals(): PlanApproval[] {
    const rows = this.database.prepare("SELECT record_json FROM plan_approvals ORDER BY updated_at DESC, id DESC").all() as unknown as Array<{ record_json: string }>;
    return rows.map((row) => normalizePlanApproval(row.record_json));
  }

  saveReconciliationTransaction(transaction: ReconciliationTransaction): void {
    const record = JSON.stringify(transaction);
    this.database.prepare(`
      INSERT INTO reconciliation_transactions(id, plan_approval_id, status, record_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_approval_id = excluded.plan_approval_id,
        status = excluded.status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(transaction.id, transaction.planApprovalId, transaction.status, record, transaction.updatedAt);
  }

  getReconciliationTransaction(id: string): ReconciliationTransaction | undefined {
    const row = this.database.prepare("SELECT record_json FROM reconciliation_transactions WHERE id = ?").get(id) as
      | { record_json: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.record_json) as ReconciliationTransaction;
  }

  getApprovalReconciliationTransaction(planApprovalId: string): ReconciliationTransaction | undefined {
    const row = this.database.prepare(`
      SELECT record_json FROM reconciliation_transactions
      WHERE plan_approval_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(planApprovalId) as { record_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.record_json) as ReconciliationTransaction;
  }

  listReconciliationTransactions(): ReconciliationTransaction[] {
    const rows = this.database.prepare(`
      SELECT record_json FROM reconciliation_transactions ORDER BY updated_at DESC, id DESC
    `).all() as unknown as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as ReconciliationTransaction);
  }

  beginExecutionApplication(approval: PlanApproval, transaction: ReconciliationTransaction): void {
    const approvalJson = JSON.stringify(approval);
    const transactionJson = JSON.stringify(transaction);
    const event = this.createEvent({
      kind: "execution.approval_accepted",
      actor: "user",
      payload: {
        planApprovalId: approval.id,
        reconciliationTransactionId: transaction.id,
        planHash: approval.planHash,
        reconciliationDigest: approval.reconciliationDigest,
      },
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.database.prepare("SELECT id FROM execution_grants WHERE status = 'active' LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (active !== undefined) throw new Error(`Execution grant ${active.id} is already active.`);
      this.database.prepare(`
        INSERT INTO plan_approvals(id, status, record_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at
      `).run(approval.id, approval.status, approvalJson, approval.decidedAt ?? approval.preparedAt);
      this.database.prepare(`
        INSERT INTO reconciliation_transactions(id, plan_approval_id, status, record_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at
      `).run(transaction.id, transaction.planApprovalId, transaction.status, transactionJson, transaction.updatedAt);
      this.insertEvent(event);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failExecutionApplication(approval: PlanApproval, transaction: ReconciliationTransaction, reason: string): void {
    const timestamp = nowIso();
    const invalidated: PlanApproval = {
      ...approval,
      status: "invalidated",
      decidedAt: timestamp,
      invalidationReason: reason,
    };
    const failed: ReconciliationTransaction = {
      ...transaction,
      status: "failed",
      updatedAt: timestamp,
      error: reason,
    };
    const event = this.createEvent({
      kind: "execution.start_failed",
      actor: "system",
      payload: {
        planApprovalId: approval.id,
        reconciliationTransactionId: transaction.id,
        error: reason,
      },
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE plan_approvals SET status = ?, record_json = ?, updated_at = ? WHERE id = ?
      `).run(invalidated.status, JSON.stringify(invalidated), timestamp, invalidated.id);
      this.database.prepare(`
        UPDATE reconciliation_transactions SET status = ?, record_json = ?, updated_at = ? WHERE id = ?
      `).run(failed.status, JSON.stringify(failed), timestamp, failed.id);
      this.upsertState("workflowMode", JSON.stringify("plan"), timestamp);
      this.database.prepare("DELETE FROM state WHERE key IN ('approvedPlanHash', 'currentPlanApprovalId', 'currentExecutionGrantId', 'currentTaskId')").run();
      this.insertEvent(event);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveExecutionGrant(grant: ExecutionGrant): void {
    const record = JSON.stringify(grant);
    this.database.prepare(`
      INSERT INTO execution_grants(id, status, task_id, record_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        task_id = excluded.task_id,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(grant.id, grant.status, grant.taskId, record, grant.revokedAt ?? grant.issuedAt);
  }

  getActiveExecutionGrant(): ExecutionGrant | undefined {
    const row = this.database.prepare("SELECT record_json FROM execution_grants WHERE status = 'active' LIMIT 1").get() as
      | { record_json: string }
      | undefined;
    return row === undefined ? undefined : normalizeExecutionGrant(row.record_json);
  }

  listExecutionGrants(): ExecutionGrant[] {
    const rows = this.database.prepare("SELECT record_json FROM execution_grants ORDER BY updated_at DESC, id DESC").all() as unknown as Array<{ record_json: string }>;
    return rows.map((row) => normalizeExecutionGrant(row.record_json));
  }

  activateExecution(input: {
    approval: PlanApproval;
    transaction: ReconciliationTransaction;
    grant: ExecutionGrant;
    permissionGrants: PermissionGrant[];
  }): void {
    if (input.permissionGrants.some((grant) => grant.executionGrantId !== input.grant.id || grant.taskId !== input.grant.taskId)) {
      throw new Error("Every task capability grant must be bound to the execution grant and active task.");
    }
    const approvalJson = JSON.stringify(input.approval);
    const transactionJson = JSON.stringify(input.transaction);
    const grantJson = JSON.stringify(input.grant);
    const approvalEvent = this.createEvent({
      kind: "plan.approved",
      actor: "user",
      taskId: input.grant.taskId,
      payload: {
        planApprovalId: input.approval.id,
        reconciliationTransactionId: input.transaction.id,
        planHash: input.approval.planHash,
        reconciliationDigest: input.approval.reconciliationDigest,
      },
    });
    const event = this.createEvent({
      kind: "execution.started",
      actor: "user",
      taskId: input.grant.taskId,
      payload: {
        executionGrantId: input.grant.id,
        planApprovalId: input.approval.id,
        reconciliationTransactionId: input.transaction.id,
      },
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO plan_approvals(id, status, record_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at
      `).run(input.approval.id, input.approval.status, approvalJson, input.approval.decidedAt ?? input.approval.preparedAt);
      this.database.prepare(`
        INSERT INTO reconciliation_transactions(id, plan_approval_id, status, record_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at
      `).run(input.transaction.id, input.transaction.planApprovalId, input.transaction.status, transactionJson, input.transaction.updatedAt);
      this.database.prepare(`
        INSERT INTO execution_grants(id, status, task_id, record_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, task_id = excluded.task_id, record_json = excluded.record_json, updated_at = excluded.updated_at
      `).run(input.grant.id, input.grant.status, input.grant.taskId, grantJson, input.grant.issuedAt);
      for (const permissionGrant of input.permissionGrants) {
        this.saveGrant(permissionGrant);
        this.insertEvent(this.createEvent({
          kind: "permission.granted",
          actor: "user",
          taskId: input.grant.taskId,
          payload: permissionGrant,
        }));
      }
      this.upsertState("approvedPlanHash", JSON.stringify(input.approval.planHash), input.grant.issuedAt);
      this.upsertState("currentPlanApprovalId", JSON.stringify(input.approval.id), input.grant.issuedAt);
      this.upsertState("currentExecutionGrantId", JSON.stringify(input.grant.id), input.grant.issuedAt);
      this.upsertState("currentTaskId", JSON.stringify(input.grant.taskId), input.grant.issuedAt);
      this.upsertState("workflowMode", JSON.stringify("act"), input.grant.issuedAt);
      this.insertEvent(approvalEvent);
      this.insertEvent(event);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  invalidateExecutionGrant(id: string, input: {
    status: "revoked" | "invalidated";
    reason: string;
    occurredAt?: string;
    workflowStatus?: "cancelled" | "completed" | "failed";
    workflowCheckpoint?: "cancelled" | "completed" | "failed";
  }): ExecutionGrant | undefined {
    const current = this.getActiveExecutionGrant();
    if (current === undefined || current.id !== id) return undefined;
    const occurredAt = input.occurredAt ?? nowIso();
    const next: ExecutionGrant = {
      ...current,
      status: input.status,
      revokedAt: occurredAt,
      invalidationReason: input.reason,
    };
    const record = JSON.stringify(next);
    const event = this.createEvent({
      kind: input.status === "revoked" ? "execution.revoked" : "execution.invalidated",
      actor: "system",
      taskId: current.taskId,
      payload: { executionGrantId: id, reason: input.reason },
    });
    const run = this.getCurrentWorkflowRun();
    const workflowStatus = input.workflowStatus ?? (input.status === "revoked" ? "cancelled" : "failed");
    const workflowCheckpoint = input.workflowCheckpoint ?? workflowStatus;
    const nextRun = run === undefined ? undefined : {
      ...run,
      status: workflowStatus,
      checkpoint: workflowCheckpoint,
      updatedAt: occurredAt,
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE execution_grants SET status = ?, record_json = ?, updated_at = ? WHERE id = ?
      `).run(next.status, record, occurredAt, id);
      this.database.prepare(`
        UPDATE permission_grants SET revoked_at = ?
        WHERE execution_grant_id = ? AND revoked_at IS NULL
      `).run(occurredAt, id);
      if (nextRun !== undefined) {
        this.database.prepare(`
          UPDATE workflow_runs SET status = ?, checkpoint = ?, record_json = ?, updated_at = ? WHERE id = ?
        `).run(nextRun.status, nextRun.checkpoint, JSON.stringify(nextRun), occurredAt, nextRun.id);
      }
      this.upsertState("workflowMode", JSON.stringify("plan"), occurredAt);
      this.database.prepare("DELETE FROM state WHERE key IN ('currentExecutionGrantId', 'currentTaskId', 'executionPause')").run();
      this.insertEvent(event);
      this.insertEvent(this.createEvent({
        kind: `workflow.${workflowStatus}`,
        actor: "system",
        taskId: current.taskId,
        payload: { workflowRunId: nextRun?.id, executionGrantId: id, reason: input.reason },
      }));
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getExecutionPause(): ExecutionPause | undefined {
    return this.getState<ExecutionPause>("executionPause");
  }

  pauseExecution(grant: ExecutionGrant, reason: string): ExecutionPause {
    const current = this.getActiveExecutionGrant();
    if (current === undefined || current.id !== grant.id) throw new Error("Only the active execution can be paused.");
    const timestamp = nowIso();
    const pause: ExecutionPause = { executionGrantId: grant.id, taskId: grant.taskId, reason, pausedAt: timestamp };
    const run = this.getCurrentWorkflowRun();
    const nextRun = run === undefined ? undefined : { ...run, status: "active" as const, checkpoint: "paused" as const, updatedAt: timestamp };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertState("executionPause", JSON.stringify(pause), timestamp);
      if (nextRun !== undefined) {
        this.database.prepare(`UPDATE workflow_runs SET status = ?, checkpoint = ?, record_json = ?, updated_at = ? WHERE id = ?`)
          .run(nextRun.status, nextRun.checkpoint, JSON.stringify(nextRun), timestamp, nextRun.id);
      }
      this.insertEvent(this.createEvent({
        kind: "execution.paused",
        actor: "user",
        taskId: grant.taskId,
        payload: pause,
      }));
      this.database.exec("COMMIT");
      return pause;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  resumePausedExecution(grant: ExecutionGrant): boolean {
    const pause = this.getExecutionPause();
    if (pause === undefined || pause.executionGrantId !== grant.id) return false;
    const timestamp = nowIso();
    const run = this.getCurrentWorkflowRun();
    const nextRun = run === undefined ? undefined : { ...run, status: "active" as const, checkpoint: "executing" as const, updatedAt: timestamp };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM state WHERE key = 'executionPause'").run();
      if (nextRun !== undefined) {
        this.database.prepare(`UPDATE workflow_runs SET status = ?, checkpoint = ?, record_json = ?, updated_at = ? WHERE id = ?`)
          .run(nextRun.status, nextRun.checkpoint, JSON.stringify(nextRun), timestamp, nextRun.id);
      }
      this.insertEvent(this.createEvent({
        kind: "execution.unpaused",
        actor: "user",
        taskId: grant.taskId,
        payload: { executionGrantId: grant.id, previousReason: pause.reason },
      }));
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  restoreExecution(grant: ExecutionGrant): boolean {
    const currentGrantId = this.getState<string>("currentExecutionGrantId");
    const currentTaskId = this.getState<string>("currentTaskId");
    const mode = this.getState<string>("workflowMode");
    const paused = this.getExecutionPause()?.executionGrantId === grant.id;
    const checkpoint = this.getCurrentWorkflowRun()?.checkpoint;
    const expectedCheckpoint = paused ? "paused" : "executing";
    if (currentGrantId === grant.id && currentTaskId === grant.taskId && mode === "act" && checkpoint === expectedCheckpoint) {
      return false;
    }
    const timestamp = nowIso();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertState("currentExecutionGrantId", JSON.stringify(grant.id), timestamp);
      this.upsertState("currentTaskId", JSON.stringify(grant.taskId), timestamp);
      this.upsertState("workflowMode", JSON.stringify("act"), timestamp);
      const run = this.getCurrentWorkflowRun();
      if (run !== undefined && run.checkpoint !== expectedCheckpoint) {
        const nextRun = { ...run, status: "active" as const, checkpoint: expectedCheckpoint, updatedAt: timestamp };
        this.database.prepare(`UPDATE workflow_runs SET status = ?, checkpoint = ?, record_json = ?, updated_at = ? WHERE id = ?`)
          .run(nextRun.status, nextRun.checkpoint, JSON.stringify(nextRun), timestamp, nextRun.id);
      }
      this.insertEvent(this.createEvent({
        kind: "execution.resumed",
        actor: "system",
        taskId: grant.taskId,
        payload: { executionGrantId: grant.id },
      }));
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveGrant(grant: PermissionGrant): void {
    this.database
      .prepare(`
        INSERT INTO permission_grants(
          id, execution_grant_id, permission, scope, actor, task_id, repository_id, paths_json,
          validation_names_json, command_prefix_json, reason, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          execution_grant_id = excluded.execution_grant_id,
          permission = excluded.permission,
          scope = excluded.scope,
          actor = excluded.actor,
          task_id = excluded.task_id,
          repository_id = excluded.repository_id,
          paths_json = excluded.paths_json,
          validation_names_json = excluded.validation_names_json,
          command_prefix_json = excluded.command_prefix_json,
          reason = excluded.reason,
          expires_at = excluded.expires_at,
          revoked_at = excluded.revoked_at
      `)
      .run(
        grant.id,
        grant.executionGrantId ?? null,
        grant.permission,
        grant.scope,
        grant.actor,
        grant.taskId ?? null,
        grant.repositoryId ?? null,
        grant.paths === undefined ? null : JSON.stringify(grant.paths),
        grant.validationNames === undefined ? null : JSON.stringify(grant.validationNames),
        null,
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
      ...(row.execution_grant_id === null ? {} : { executionGrantId: row.execution_grant_id }),
      permission: row.permission,
      scope: row.scope,
      actor: row.actor,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.repository_id === null ? {} : { repositoryId: row.repository_id }),
      ...(row.paths_json === null ? {} : { paths: JSON.parse(row.paths_json) as string[] }),
      ...(row.validation_names_json === null ? {} : { validationNames: JSON.parse(row.validation_names_json) as string[] }),
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
    return row == null
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

  private createEvent<TPayload>(input: {
    kind: string;
    actor: Actor;
    taskId?: string;
    repositorySnapshot?: RepositorySnapshot;
    payload: TPayload;
  }): LedgerEvent<TPayload> {
    return {
      id: newId("evt"),
      kind: input.kind,
      occurredAt: nowIso(),
      actor: input.actor,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.repositorySnapshot === undefined ? {} : { repositorySnapshot: input.repositorySnapshot }),
      payload: redactValue(input.payload),
    };
  }

  private insertEvent(event: LedgerEvent): void {
    this.database.prepare(`
      INSERT INTO ledger_events(
        id, kind, occurred_at, actor, task_id, repository_snapshot_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.kind,
      event.occurredAt,
      event.actor,
      event.taskId ?? null,
      event.repositorySnapshot === undefined ? null : JSON.stringify(event.repositorySnapshot),
      JSON.stringify(event.payload),
    );
  }

  private upsertState(key: string, valueJson: string, updatedAt: string): void {
    this.database.prepare(`
      INSERT INTO state(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, valueJson, updatedAt);
  }

  private hasTable(table: string): boolean {
    return this.database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  }

  dataSummary(): Record<string, number> {
    const tables = ["ledger_events", "execution_evidence", "validation_evidence", "retrieval_sessions", "retrieval_requests", "retrieval_evidence", "retrieval_provenance"];
    return Object.fromEntries(tables.map((table) => {
      if (!this.hasTable(table)) return [table, 0];
      const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, Number(row.count)];
    }));
  }

  pruneData(options: { before?: string; keep?: number } = {}): Record<string, number> {
    const before = options.before ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const keep = Math.max(0, options.keep ?? 1_000);
    const changes: Record<string, number> = {};
    const deleteOld = (table: string, timeColumn: string, idColumn = "id"): void => {
      if (!this.hasTable(table)) { changes[table] = 0; return; }
      const result = this.database.prepare(`DELETE FROM ${table} WHERE ${timeColumn} < ? AND ${idColumn} NOT IN (SELECT ${idColumn} FROM ${table} ORDER BY ${timeColumn} DESC LIMIT ?)`).run(before, keep);
      changes[table] = Number(result.changes);
    };
    deleteOld("ledger_events", "occurred_at");
    deleteOld("execution_evidence", "updated_at");
    deleteOld("validation_evidence", "started_at");
    deleteOld("retrieval_sessions", "updated_at");
    return changes;
  }

  deleteHistoricalData(): Record<string, number> {
    const tables = ["retrieval_provenance", "retrieval_invalidations", "retrieval_evidence", "retrieval_requests", "retrieval_sessions", "validation_evidence", "focused_validation_selections", "execution_evidence", "ledger_events"];
    const changes: Record<string, number> = {};
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of tables) changes[table] = this.hasTable(table) ? Number(this.database.prepare(`DELETE FROM ${table}`).run().changes) : 0;
      this.database.exec("COMMIT");
      return changes;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exportData(): Record<string, unknown[]> {
    const tables = ["ledger_events", "execution_evidence", "validation_evidence", "retrieval_sessions", "retrieval_requests", "retrieval_evidence", "retrieval_provenance"];
    return Object.fromEntries(tables.map((table) => [table, this.hasTable(table) ? this.database.prepare(`SELECT * FROM ${table}`).all() as unknown[] : []]));
  }

  close(): void {
    this.database.close();
  }
}
