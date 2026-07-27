import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { SqliteDatabase } from "../ledger/sqlite-runtime.ts";
import type {
  FocusedValidationSelection,
  RepositorySnapshot,
  TaskClosureReadiness,
  ValidationEvidenceRecord,
  ValidationEvidenceSummary,
} from "../domain/types.ts";
import { nowIso, newId } from "../util/ids.ts";

export interface ValidationDefinition {
  command: string[];
  description?: string;
  approval?: "never" | "always";
  longRunningAfterMs?: number;
  focused?: boolean;
  category?: "focused" | "full";
  required?: boolean;
  paths?: string[];
  symbols?: string[];
}

export interface ValidationManifest {
  validations: Record<string, ValidationDefinition>;
}

export type ValidationEvidence = ValidationEvidenceRecord;

export interface FocusedValidationCandidate {
  name: string;
  reason: string;
  required: boolean;
}

export class ValidationService {
  private readonly root: string;
  private readonly database: SqliteDatabase;
  private readonly manifestPath: string;

  constructor(options: { root: string; database: SqliteDatabase; manifestPath?: string }) {
    this.root = resolve(options.root);
    this.database = options.database;
    this.manifestPath = resolve(this.root, options.manifestPath ?? ".atelier/validation.json");
    this.migrate();
  }

  manifest(): ValidationManifest {
    if (!existsSync(this.manifestPath)) return { validations: {} };
    const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as ValidationManifest;
    if (parsed === null || typeof parsed !== "object" || parsed.validations === null || typeof parsed.validations !== "object") {
      throw new Error(`Invalid validation manifest: ${this.manifestPath}`);
    }
    for (const [name, definition] of Object.entries(parsed.validations)) {
      if (!Array.isArray(definition.command) || definition.command.length === 0 || !definition.command.every((item) => typeof item === "string")) {
        throw new Error(`Validation ${name} must define a non-empty string-array command.`);
      }
      if (definition.category !== undefined && definition.category !== "focused" && definition.category !== "full") {
        throw new Error(`Validation ${name} has invalid category ${String(definition.category)}.`);
      }
    }
    return parsed;
  }

  definition(name: string): ValidationDefinition | undefined {
    return this.manifest().validations[name];
  }

  action(name: string): "validation.focused" | "validation.full_suite" {
    const definition = this.definition(name);
    if (definition === undefined) throw new Error(`Unknown validation: ${name}`);
    return definition.category === "full" ? "validation.full_suite" : "validation.focused";
  }

  planFocused(changedPaths: string[], changedSymbols: string[]): FocusedValidationCandidate[] {
    const manifest = this.manifest();
    const selected: FocusedValidationCandidate[] = [];
    for (const [name, definition] of Object.entries(manifest.validations)) {
      if (definition.category === "full" || (definition.focused !== true && definition.category !== "focused")) continue;
      const pathMatches = (definition.paths ?? []).filter((pattern) => changedPaths.some((path) => pathMatchesPattern(path, pattern)));
      const symbolMatches = (definition.symbols ?? []).filter((pattern) => changedSymbols.some((symbol) => symbolMatchesPattern(symbol, pattern)));
      const required = definition.required === true;
      if (pathMatches.length > 0) {
        selected.push({ name, reason: `Matched changed path rule(s): ${pathMatches.join(", ")}`, required });
      } else if (symbolMatches.length > 0) {
        selected.push({ name, reason: `Matched changed symbol rule(s): ${symbolMatches.join(", ")}`, required });
      } else if ((definition.paths?.length ?? 0) === 0 && (definition.symbols?.length ?? 0) === 0) {
        selected.push({ name, reason: "Configured as a default focused validation.", required });
      }
    }
    return selected;
  }

  saveFocusedSelection(input: Omit<FocusedValidationSelection, "id" | "selected" | "noMatch" | "createdAt">): FocusedValidationSelection {
    const selected = this.planFocused(input.changedPaths, input.changedSymbols);
    const selection: FocusedValidationSelection = {
      id: newId("validation-selection"),
      ...input,
      changedPaths: [...new Set(input.changedPaths)].sort(),
      changedSymbols: [...new Set(input.changedSymbols)].sort(),
      selected,
      noMatch: selected.length === 0,
      createdAt: nowIso(),
    };
    this.database.prepare(`
      INSERT INTO focused_validation_selections(
        id, task_id, execution_grant_id, snapshot_fingerprint, record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      selection.id,
      selection.taskId,
      selection.executionGrantId,
      selection.snapshot.dirtyFingerprint,
      JSON.stringify(selection),
      selection.createdAt,
    );
    return selection;
  }

  listFocusedSelections(options: { taskId?: string; executionGrantId?: string; limit?: number } = {}): FocusedValidationSelection[] {
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
    parameters.push(options.limit ?? 20);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database.prepare(`
      SELECT record_json FROM focused_validation_selections ${where}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters) as unknown as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as FocusedValidationSelection);
  }

  async run(
    name: string,
    snapshot: RepositorySnapshot,
    options: {
      signal?: AbortSignal;
      taskId?: string;
      executionGrantId?: string;
      planHash?: string;
      selectionId?: string;
      maxOutputBytes?: number;
    } = {},
  ): Promise<ValidationEvidence> {
    const definition = this.manifest().validations[name];
    if (definition === undefined) throw new Error(`Unknown validation: ${name}`);
    const [executable, ...args] = definition.command;
    if (executable === undefined) throw new Error(`Validation ${name} has no executable.`);
    const startedAt = nowIso();
    const started = Date.now();
    const maximum = Math.max(1, options.maxOutputBytes ?? 50 * 1024);

    if (options.signal?.aborted === true) {
      return this.persistEvidence({
        id: newId("validation"),
        name,
        command: [...definition.command],
        ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        ...(options.executionGrantId === undefined ? {} : { executionGrantId: options.executionGrantId }),
        ...(options.planHash === undefined ? {} : { planHash: options.planHash }),
        ...(options.selectionId === undefined ? {} : { selectionId: options.selectionId }),
        snapshotFingerprint: snapshot.dirtyFingerprint,
        startedAt,
        finishedAt: nowIso(),
        durationMs: 0,
        exitCode: 130,
        status: "interrupted",
        stdout: "",
        stderr: "Validation was cancelled before process start.",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }

    return new Promise<ValidationEvidence>((resolvePromise) => {
      const child = spawn(executable, args, {
        cwd: this.root,
        env: process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let aborted = false;
      let settled = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;

      const append = (current: Buffer, chunk: Buffer | string): { value: Buffer; truncated: boolean } => {
        const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        return next.length <= maximum
          ? { value: next, truncated: false }
          : { value: Buffer.from(next.subarray(next.length - maximum)), truncated: true };
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        const next = append(stdout, chunk);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const next = append(stderr, chunk);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
      });

      const abort = (): void => {
        aborted = true;
        terminateProcess(child, "SIGTERM");
        forceKill = setTimeout(() => terminateProcess(child, "SIGKILL"), 1_000);
        forceKill.unref?.();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted === true) abort();

      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        if (forceKill !== undefined) clearTimeout(forceKill);
        options.signal?.removeEventListener("abort", abort);
        const interrupted = aborted || signal !== null;
        const exitCode = code ?? (interrupted ? 130 : 1);
        let finalStderr = stderr;
        if (error !== undefined) {
          const combined = append(finalStderr, `${finalStderr.length === 0 ? "" : "\n"}${error.message}`);
          finalStderr = combined.value;
          stderrTruncated ||= combined.truncated;
        }
        const evidence = this.persistEvidence({
          id: newId("validation"),
          name,
          command: [...definition.command],
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
          ...(options.executionGrantId === undefined ? {} : { executionGrantId: options.executionGrantId }),
          ...(options.planHash === undefined ? {} : { planHash: options.planHash }),
          ...(options.selectionId === undefined ? {} : { selectionId: options.selectionId }),
          snapshotFingerprint: snapshot.dirtyFingerprint,
          startedAt,
          finishedAt: nowIso(),
          durationMs: Date.now() - started,
          exitCode,
          status: interrupted ? "interrupted" : exitCode === 0 ? "passed" : "failed",
          stdout: stdout.toString("utf8"),
          stderr: finalStderr.toString("utf8"),
          stdoutTruncated,
          stderrTruncated,
        });
        resolvePromise(evidence);
      };
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signal) => finish(code, signal));
    });
  }

  list(options: {
    name?: string;
    taskId?: string;
    limit?: number;
    currentSnapshot?: RepositorySnapshot;
    currentChangedPaths?: string[];
  } = {}): Array<ValidationEvidence & { stale: boolean; staleReason?: string }> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.name !== undefined) {
      clauses.push("name = ?");
      parameters.push(options.name);
    }
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      parameters.push(options.taskId);
    }
    parameters.push(options.limit ?? 20);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database.prepare(`SELECT * FROM validation_evidence ${where} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...parameters);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => {
      const evidence = evidenceFromRow(row);
      const stale = options.currentSnapshot !== undefined
        && options.currentSnapshot.dirtyFingerprint !== evidence.snapshotFingerprint;
      return {
        ...evidence,
        stale,
        ...(stale ? {
          staleReason: `Repository fingerprint changed from ${evidence.snapshotFingerprint} to ${options.currentSnapshot!.dirtyFingerprint}`
            + `${(options.currentChangedPaths?.length ?? 0) === 0 ? "" : `; newer changed paths: ${options.currentChangedPaths!.join(", ")}`}.`,
        } : {}),
      };
    });
  }

  latestCurrent(snapshot: RepositorySnapshot): ValidationEvidence[] {
    const rows = this.database.prepare(`
      SELECT v.* FROM validation_evidence v
      INNER JOIN (
        SELECT name, MAX(started_at) AS latest FROM validation_evidence
        WHERE snapshot_fingerprint = ? GROUP BY name
      ) latest ON latest.name = v.name AND latest.latest = v.started_at
      WHERE v.snapshot_fingerprint = ? ORDER BY v.name
    `).all(snapshot.dirtyFingerprint, snapshot.dirtyFingerprint) as unknown as Array<Record<string, unknown>>;
    return rows.map(evidenceFromRow);
  }

  summaries(snapshot: RepositorySnapshot, changedPaths: string[], taskId?: string): {
    current: ValidationEvidenceSummary[];
    stale: ValidationEvidenceSummary[];
  } {
    const all = this.list({
      ...(taskId === undefined ? {} : { taskId }),
      currentSnapshot: snapshot,
      currentChangedPaths: changedPaths,
      limit: 100,
    });
    const latest = new Map<string, (typeof all)[number]>();
    for (const item of all) if (!latest.has(item.name)) latest.set(item.name, item);
    const summaries = [...latest.values()].map((item): ValidationEvidenceSummary => ({
      id: item.id,
      name: item.name,
      status: item.status,
      durationMs: item.durationMs,
      snapshotFingerprint: item.snapshotFingerprint,
      stale: item.stale,
      ...(item.staleReason === undefined ? {} : { staleReason: item.staleReason }),
    }));
    return {
      current: summaries.filter((item) => !item.stale),
      stale: summaries.filter((item) => item.stale),
    };
  }

  closureReadiness(snapshot: RepositorySnapshot, taskId: string, executionGrantId: string): TaskClosureReadiness {
    const selection = this.listFocusedSelections({ taskId, executionGrantId, limit: 1 })[0];
    if (selection === undefined) {
      return { ready: false, required: [], missing: [], stale: [], failed: [], reason: "No focused validation selection is recorded for the active task." };
    }
    const required = selection.selected.filter((item) => item.required).map((item) => item.name).sort();
    const missing: string[] = [];
    const stale: string[] = [];
    const failed: string[] = [];
    for (const name of required) {
      const evidence = this.list({ name, taskId, limit: 20 })
        .find((item) => item.executionGrantId === executionGrantId && item.selectionId === selection.id);
      if (evidence === undefined) missing.push(name);
      else if (evidence.snapshotFingerprint !== snapshot.dirtyFingerprint) stale.push(name);
      else if (evidence.status !== "passed") failed.push(name);
    }
    const selectionStale = selection.snapshot.dirtyFingerprint !== snapshot.dirtyFingerprint;
    if (selectionStale) {
      for (const name of required) if (!stale.includes(name)) stale.push(name);
    }
    const ready = missing.length === 0 && stale.length === 0 && failed.length === 0;
    return {
      ready,
      required,
      missing,
      stale: stale.sort(),
      failed,
      reason: ready
        ? required.length === 0 ? "Focused selection has no required checks." : "All required focused validations are current and passing."
        : `Task closure blocked: ${[
            missing.length === 0 ? "" : `missing ${missing.join(", ")}`,
            stale.length === 0 ? "" : `stale ${stale.join(", ")}`,
            failed.length === 0 ? "" : `not passing ${failed.join(", ")}`,
          ].filter(Boolean).join("; ")}.`,
    };
  }

  private persistEvidence(evidence: ValidationEvidence): ValidationEvidence {
    this.database.prepare(`
      INSERT INTO validation_evidence(
        id, name, command_json, task_id, execution_grant_id, plan_hash, selection_id,
        snapshot_fingerprint, started_at, finished_at, duration_ms, exit_code, status,
        stdout, stderr, stdout_truncated, stderr_truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id,
      evidence.name,
      JSON.stringify(evidence.command),
      evidence.taskId ?? null,
      evidence.executionGrantId ?? null,
      evidence.planHash ?? null,
      evidence.selectionId ?? null,
      evidence.snapshotFingerprint,
      evidence.startedAt,
      evidence.finishedAt,
      evidence.durationMs,
      evidence.exitCode,
      evidence.status,
      evidence.stdout,
      evidence.stderr,
      evidence.stdoutTruncated ? 1 : 0,
      evidence.stderrTruncated ? 1 : 0,
    );
    return evidence;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS validation_evidence (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command_json TEXT NOT NULL,
        task_id TEXT,
        execution_grant_id TEXT,
        plan_hash TEXT,
        selection_id TEXT,
        snapshot_fingerprint TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        exit_code INTEGER NOT NULL,
        status TEXT NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS validation_evidence_name_time
        ON validation_evidence(name, started_at DESC);
      CREATE INDEX IF NOT EXISTS validation_evidence_snapshot
        ON validation_evidence(snapshot_fingerprint, started_at DESC);
      CREATE INDEX IF NOT EXISTS validation_evidence_task_time
        ON validation_evidence(task_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS focused_validation_selections (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_grant_id TEXT NOT NULL,
        snapshot_fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS focused_validation_task_time
        ON focused_validation_selections(task_id, created_at DESC);
    `);
    const columns = this.database.prepare("PRAGMA table_info(validation_evidence)").all() as unknown as Array<{ name: string }>;
    for (const [name, declaration] of [
      ["task_id", "TEXT"],
      ["execution_grant_id", "TEXT"],
      ["plan_hash", "TEXT"],
      ["selection_id", "TEXT"],
      ["stdout_truncated", "INTEGER NOT NULL DEFAULT 0"],
      ["stderr_truncated", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.database.exec(`ALTER TABLE validation_evidence ADD COLUMN ${name} ${declaration}`);
      }
    }
  }
}

function evidenceFromRow(row: Record<string, unknown>): ValidationEvidence {
  return {
    id: row.id as string,
    name: row.name as string,
    command: JSON.parse(row.command_json as string) as string[],
    ...(typeof row.task_id === "string" ? { taskId: row.task_id } : {}),
    ...(typeof row.execution_grant_id === "string" ? { executionGrantId: row.execution_grant_id } : {}),
    ...(typeof row.plan_hash === "string" ? { planHash: row.plan_hash } : {}),
    ...(typeof row.selection_id === "string" ? { selectionId: row.selection_id } : {}),
    snapshotFingerprint: row.snapshot_fingerprint as string,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string,
    durationMs: Number(row.duration_ms),
    exitCode: Number(row.exit_code),
    status: row.status as ValidationEvidence["status"],
    stdout: row.stdout as string,
    stderr: row.stderr as string,
    stdoutTruncated: Number(row.stdout_truncated ?? 0) !== 0,
    stderrTruncated: Number(row.stderr_truncated ?? 0) !== 0,
  };
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* Process already exited. */ }
  }
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function symbolMatchesPattern(symbol: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return symbol.startsWith(pattern.slice(0, -1));
  return symbol === pattern;
}
