import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { RepositorySnapshot } from "../domain/types.ts";
import { nowIso, newId } from "../util/ids.ts";

export interface ValidationDefinition {
  command: string[];
  description?: string;
  approval?: "never" | "always";
  longRunningAfterMs?: number;
  focused?: boolean;
  paths?: string[];
  symbols?: string[];
}

export interface ValidationManifest {
  validations: Record<string, ValidationDefinition>;
}

export interface ValidationEvidence {
  id: string;
  name: string;
  command: string[];
  snapshotFingerprint: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  status: "passed" | "failed" | "interrupted";
  stdout: string;
  stderr: string;
}

export class ValidationService {
  private readonly root: string;
  private readonly database: DatabaseSync;
  private readonly manifestPath: string;

  constructor(options: { root: string; database: DatabaseSync; manifestPath?: string }) {
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
    }
    return parsed;
  }


  planFocused(changedPaths: string[], changedSymbols: string[]): Array<{ name: string; reason: string }> {
    const manifest = this.manifest();
    const selected: Array<{ name: string; reason: string }> = [];
    for (const [name, definition] of Object.entries(manifest.validations)) {
      const pathMatches = (definition.paths ?? []).filter((pattern) => changedPaths.some((path) => pathMatchesPattern(path, pattern)));
      const symbolMatches = (definition.symbols ?? []).filter((pattern) => changedSymbols.some((symbol) => symbolMatchesPattern(symbol, pattern)));
      if (pathMatches.length > 0) {
        selected.push({ name, reason: `Matched changed path rule(s): ${pathMatches.join(", ")}` });
      } else if (symbolMatches.length > 0) {
        selected.push({ name, reason: `Matched changed symbol rule(s): ${symbolMatches.join(", ")}` });
      } else if (definition.focused === true && (definition.paths?.length ?? 0) === 0 && (definition.symbols?.length ?? 0) === 0) {
        selected.push({ name, reason: "Configured as a default focused validation." });
      }
    }
    return selected;
  }

  run(name: string, snapshot: RepositorySnapshot): ValidationEvidence {
    const definition = this.manifest().validations[name];
    if (definition === undefined) throw new Error(`Unknown validation: ${name}`);
    const [executable, ...args] = definition.command;
    if (executable === undefined) throw new Error(`Validation ${name} has no executable.`);
    const startedAt = nowIso();
    const started = Date.now();
    const result = spawnSync(executable, args, {
      cwd: this.root,
      env: process.env,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    const finishedAt = nowIso();
    const exitCode = result.status ?? (result.signal ? 130 : 1);
    const evidence: ValidationEvidence = {
      id: newId("validation"),
      name,
      command: definition.command,
      snapshotFingerprint: snapshot.dirtyFingerprint,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      exitCode,
      status: result.signal ? "interrupted" : exitCode === 0 ? "passed" : "failed",
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
    this.database.prepare(`
      INSERT INTO validation_evidence(
        id, name, command_json, snapshot_fingerprint, started_at, finished_at,
        duration_ms, exit_code, status, stdout, stderr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id, evidence.name, JSON.stringify(evidence.command), evidence.snapshotFingerprint,
      evidence.startedAt, evidence.finishedAt, evidence.durationMs, evidence.exitCode,
      evidence.status, evidence.stdout, evidence.stderr,
    );
    return evidence;
  }

  list(options: { name?: string; limit?: number; currentSnapshot?: RepositorySnapshot } = {}): Array<ValidationEvidence & { stale: boolean }> {
    const rows = options.name === undefined
      ? this.database.prepare("SELECT * FROM validation_evidence ORDER BY started_at DESC LIMIT ?").all(options.limit ?? 20)
      : this.database.prepare("SELECT * FROM validation_evidence WHERE name = ? ORDER BY started_at DESC LIMIT ?").all(options.name, options.limit ?? 20);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      command: JSON.parse(row.command_json as string) as string[],
      snapshotFingerprint: row.snapshot_fingerprint as string,
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string,
      durationMs: row.duration_ms as number,
      exitCode: row.exit_code as number,
      status: row.status as ValidationEvidence["status"],
      stdout: row.stdout as string,
      stderr: row.stderr as string,
      stale: options.currentSnapshot !== undefined && options.currentSnapshot.dirtyFingerprint !== row.snapshot_fingerprint,
    }));
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
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      command: JSON.parse(row.command_json as string) as string[],
      snapshotFingerprint: row.snapshot_fingerprint as string,
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string,
      durationMs: row.duration_ms as number,
      exitCode: row.exit_code as number,
      status: row.status as ValidationEvidence["status"],
      stdout: row.stdout as string,
      stderr: row.stderr as string,
    }));
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS validation_evidence (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command_json TEXT NOT NULL,
        snapshot_fingerprint TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        exit_code INTEGER NOT NULL,
        status TEXT NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS validation_evidence_name_time
        ON validation_evidence(name, started_at DESC);
      CREATE INDEX IF NOT EXISTS validation_evidence_snapshot
        ON validation_evidence(snapshot_fingerprint, started_at DESC);
    `);
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
