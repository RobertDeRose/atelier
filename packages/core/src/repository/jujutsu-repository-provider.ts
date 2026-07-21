import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { RepositorySnapshot } from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { sha256 } from "../util/hash.ts";
import type { RepositoryProvider, RepositoryProviderStatus } from "./repository-provider.ts";

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

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export class JujutsuRepositoryProvider implements RepositoryProvider {
  readonly name = "jj" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly executable: string;
  private readonly indexSchemaVersion: number;

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
    const rootResult = run(this.executable, this.cwd, ["root"]);
    if (rootResult.status !== 0) {
      throw new Error(rootResult.stderr.trim() || "Not a Jujutsu repository");
    }
    const root = rootResult.stdout.trim();
    const workspaceRoot = run(this.executable, this.cwd, ["workspace", "root"]);
    const identity = run(this.executable, root, [
      "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id ++ "\\n" ++ commit_id ++ "\\n"',
    ]);
    if (identity.status !== 0) throw new Error(identity.stderr.trim() || "Unable to read Jujutsu change identity");
    const [changeId = "unknown", commitId = "unknown"] = lines(identity.stdout);
    const operation = run(this.executable, root, [
      "op", "log", "--limit", "1", "--no-graph", "--color", "never", "-T", 'id ++ "\\n"',
    ]);
    const operationId = lines(operation.stdout)[0] ?? "unknown";
    const status = run(this.executable, root, ["status", "--color", "never"]);
    const fingerprint = sha256(`${changeId}\0${commitId}\0${operationId}\0${status.stdout}`);
    return {
      repositoryId: `jj:${sha256(root).slice(0, 24)}`,
      workspaceId: basename((workspaceRoot.status === 0 ? workspaceRoot.stdout.trim() : root) || root),
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
    const result = run(this.executable, this.cwd, ["diff", "--name-only", "--color", "never"]);
    return result.status === 0 ? lines(result.stdout) : [];
  }

  diff(path?: string): string {
    const args = ["diff", "--git", "--color", "never"];
    if (path !== undefined) args.push("--", path);
    const result = run(this.executable, this.cwd, args);
    return result.status === 0 ? result.stdout : "";
  }

  listFiles(): string[] {
    const result = run(this.executable, this.cwd, ["file", "list"]);
    if (result.status !== 0) return [];
    return lines(result.stdout).filter((path) => path !== ".atelier" && !path.startsWith(".atelier/")).sort();
  }

  private dirtyGeneration(fingerprint: string): number {
    const key = "repositoryDirtyState:jj";
    const state = this.ledger.getState<{ fingerprint: string; generation: number }>(key);
    if (state === undefined) {
      this.ledger.setState(key, { fingerprint, generation: 0 });
      return 0;
    }
    if (state.fingerprint === fingerprint) return state.generation;
    const generation = state.generation + 1;
    this.ledger.setState(key, { fingerprint, generation });
    return generation;
  }
}
