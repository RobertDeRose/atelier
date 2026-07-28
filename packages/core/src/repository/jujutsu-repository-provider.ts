import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { RepositoryObservationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";
import { isSourcePath } from "./source-path.ts";
import type { RepositoryCommitResult, RepositoryProvider, RepositoryProviderStatus } from "./repository-provider.ts";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(executable: string, cwd: string, args: string[]): CommandResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function required(executable: string, cwd: string, args: string[], purpose: string): CommandResult {
  const result = run(executable, cwd, args);
  if (result.status !== 0) {
    throw new RepositoryObservationError(`Jujutsu ${purpose} failed: ${result.stderr.trim() || `exit ${result.status}`}`, {
      cwd,
      command: [executable, ...args],
      status: result.status,
    });
  }
  return result;
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}


export class JujutsuRepositoryProvider implements RepositoryProvider {
  readonly name = "jj" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly executable: string;
  private readonly indexSchemaVersion: number;
  private readonly stateKey: string;

  constructor(options: {
    cwd: string;
    ledger: SqliteLedger;
    executable?: string;
    indexSchemaVersion?: number;
  }) {
    this.cwd = resolve(options.cwd);
    this.ledger = options.ledger;
    this.executable = options.executable ?? "jj";
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.stateKey = `repositoryDirtyState:jj:${sha256(this.cwd).slice(0, 16)}`;
  }

  status(): RepositoryProviderStatus {
    const version = run(this.executable, this.cwd, ["--version"]);
    if (version.status !== 0) {
      return { provider: "jj", available: false, repository: false, reason: version.stderr.trim() || "jj is unavailable" };
    }
    const root = run(this.executable, this.cwd, ["root"]);
    return {
      provider: "jj",
      available: true,
      repository: root.status === 0,
      ...(root.status === 0 ? {} : { reason: root.stderr.trim() || "not a Jujutsu repository" }),
    };
  }

  snapshot(): RepositorySnapshot {
    const root = required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim();
    const workspaceRoot = required(this.executable, this.cwd, ["workspace", "root"], "workspace-root observation").stdout.trim();
    const identity = required(this.executable, root, [
      "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id ++ "\\n" ++ commit_id ++ "\\n"',
    ], "change identity observation");
    const [changeId = "unknown", commitId = "unknown"] = lines(identity.stdout);
    const operation = required(this.executable, root, [
      "op", "log", "--limit", "1", "--no-graph", "--color", "never", "-T", 'id ++ "\\n"',
    ], "operation identity observation");
    const operationId = lines(operation.stdout)[0] ?? "unknown";
    // Operation-log churn and workflow metadata are not source drift.
    const changed = this.changedPaths();
    const contentState = changed.map((path) => {
      const absolute = resolve(root, path);
      if (!existsSync(absolute)) return `${path}:deleted`;
      try {
        const stat = statSync(absolute);
        return stat.isFile() ? `${path}:${stat.size}:${sha256(readFileSync(absolute))}` : `${path}:non-file`;
      } catch {
        return `${path}:unreadable`;
      }
    }).join("\0");
    const fingerprint = sha256(`${changeId}\0${commitId}\0${changed.join("\0")}\0${contentState}`);
    return {
      repositoryId: `jj:${sha256(root).slice(0, 24)}`,
      workspaceId: sha256(workspaceRoot || root).slice(0, 16),
      vcs: "jj",
      headCommit: commitId,
      changeId,
      operationId,
      dirtyGeneration: this.dirtyGeneration(fingerprint),
      dirtyFingerprint: fingerprint,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  changedPaths(): string[] {
    const result = required(this.executable, this.cwd, ["diff", "--name-only", "--color", "never"], "changed-path observation");
    return lines(result.stdout).filter(isSourcePath).sort();
  }

  changedPathsFrom(reference: string): string[] {
    const result = required(this.executable, this.cwd, [
      "diff", "--from", reference, "--to", "@", "--name-only", "--color", "never",
    ], `changed paths from ${reference}`);
    return lines(result.stdout).filter(isSourcePath).sort();
  }

  diff(path?: string): string {
    const args = ["diff", "--git", "--color", "never"];
    if (path !== undefined) args.push("--", path);
    return required(this.executable, this.cwd, args, "working-copy diff").stdout;
  }

  diffFrom(reference: string, path?: string): string {
    const args = ["diff", "--from", reference, "--to", "@", "--git", "--color", "never"];
    if (path !== undefined) args.push("--", path);
    return required(this.executable, this.cwd, args, `diff from ${reference}`).stdout;
  }

  listFiles(): string[] {
    const result = required(this.executable, this.cwd, ["file", "list"], "file inventory");
    return lines(result.stdout).filter(isSourcePath).sort();
  }

  commit(message: string): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Change description cannot be empty.");
    const changed = this.changedPaths();
    if (changed.length === 0) throw new Error("No Jujutsu changes are available to finalize.");
    required(this.executable, this.cwd, ["describe", "-m", normalized], "change description");
    required(this.executable, this.cwd, ["new"], "new working-copy change creation");
    return { message: normalized, changedPaths: changed, snapshot: this.snapshot() };
  }

  private dirtyGeneration(fingerprint: string): number {
    const state = this.ledger.getState<{ fingerprint: string; generation: number }>(this.stateKey);
    if (state === undefined) {
      this.ledger.setState(this.stateKey, { fingerprint, generation: 0 });
      return 0;
    }
    if (state.fingerprint === fingerprint) return state.generation;
    const generation = state.generation + 1;
    this.ledger.setState(this.stateKey, { fingerprint, generation });
    return generation;
  }
}
