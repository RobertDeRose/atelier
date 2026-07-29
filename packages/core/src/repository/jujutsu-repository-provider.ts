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

function contentState(root: string, paths: string[], hashContents: boolean): string {
  return paths.map((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return `${path}:deleted`;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return `${path}:non-file:${stat.size}:${stat.mtimeMs}`;
      return hashContents
        ? `${path}:${stat.size}:${sha256(readFileSync(absolute))}`
        : `${path}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:unreadable`;
    }
  }).join("\0");
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
    const parent = required(this.executable, root, [
      "log", "-r", "@-", "--no-graph", "--color", "never", "-T", 'commit_id ++ "\n"',
    ], "source-base observation");
    const sourceBaseCommit = lines(parent.stdout)[0] ?? "unborn";
    const operation = required(this.executable, root, [
      "op", "log", "--limit", "1", "--no-graph", "--color", "never", "-T", 'id ++ "\\n"',
    ], "operation identity observation");
    const operationId = lines(operation.stdout)[0] ?? "unknown";
    // Raw VCS identity records workflow/provider metadata and operation-log
    // churn for diagnostics. Source identity deliberately excludes it.
    const rawChanged = this.observeRawChangedPaths();
    const sourceFiles = this.listFiles();
    const sourceFingerprint = sha256(
      `${sourceFiles.join("\0")}\0${contentState(root, sourceFiles, true)}`,
    );
    const rawFingerprint = sha256(
      `${commitId}\0${changeId}\0${operationId}\0${rawChanged.join("\0")}\0${sourceFingerprint}\0${contentState(root, rawChanged, false)}`,
    );
    return {
      repositoryId: `jj:${sha256(root).slice(0, 24)}`,
      workspaceId: sha256(workspaceRoot || root).slice(0, 16),
      vcs: "jj",
      headCommit: commitId,
      sourceBaseCommit,
      sourceFingerprint,
      changeId,
      operationId,
      dirtyGeneration: this.dirtyGeneration(rawFingerprint),
      dirtyFingerprint: rawFingerprint,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  changedPaths(): string[] {
    return this.rawChangedPaths().filter(isSourcePath);
  }

  rawChangedPaths(): string[] {
    return this.observeRawChangedPaths();
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

  commit(message: string, paths?: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Change description cannot be empty.");
    const changed = (paths ?? this.changedPaths()).filter(isSourcePath);
    if (changed.length === 0) throw new Error("No Jujutsu source changes are available to finalize.");
    if (paths === undefined) {
      required(this.executable, this.cwd, ["describe", "-m", normalized], "change description");
      required(this.executable, this.cwd, ["new"], "new working-copy change creation");
    } else {
      required(this.executable, this.cwd, ["commit", "-m", normalized, "--", ...changed], "scoped task change creation");
    }
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

  commitMetadata(message: string, paths: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Metadata change description cannot be empty.");
    const changed = [...new Set(paths)].sort();
    if (changed.length === 0) throw new Error("No workflow metadata changes are available to finalize.");
    required(this.executable, this.cwd, ["commit", "-m", normalized, "--", ...changed], "workflow metadata change creation");
    return { message: normalized, changedPaths: changed, snapshot: this.snapshot() };
  }

  private observeRawChangedPaths(): string[] {
    const result = required(this.executable, this.cwd, ["diff", "--name-only", "--color", "never"], "changed-path observation");
    return lines(result.stdout).sort();
  }
}
