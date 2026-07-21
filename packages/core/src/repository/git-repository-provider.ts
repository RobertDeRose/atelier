import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { RepositoryProvider, RepositoryProviderStatus } from "./repository-provider.ts";
import { sha256 } from "../util/hash.ts";

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
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

export class GitRepositoryProvider implements RepositoryProvider {
  readonly name = "git" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly indexSchemaVersion: number;

  constructor(options: { cwd: string; ledger: SqliteLedger; indexSchemaVersion?: number }) {
    this.cwd = resolve(options.cwd);
    this.ledger = options.ledger;
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
  }

  status(): RepositoryProviderStatus {
    const version = runGit(this.cwd, ["--version"]);
    if (version.status !== 0) return { provider: "git", available: false, repository: false, reason: version.stderr.trim() || "git is unavailable" };
    const root = runGit(this.cwd, ["rev-parse", "--show-toplevel"]);
    return { provider: "git", available: true, repository: root.status === 0, ...(root.status === 0 ? {} : { reason: root.stderr.trim() || "not a Git repository" }) };
  }

  snapshot(): RepositorySnapshot {
    const rootResult = runGit(this.cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.status !== 0) {
      return {
        repositoryId: `directory:${sha256(this.cwd).slice(0, 16)}`,
        workspaceId: basename(this.cwd),
        vcs: "none",
        headCommit: "none",
        dirtyGeneration: this.dirtyGeneration("none"),
        dirtyFingerprint: "none",
        indexSchemaVersion: this.indexSchemaVersion,
      };
    }

    const root = rootResult.stdout.trim();
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const commonDir = runGit(root, ["rev-parse", "--git-common-dir"]);
    const statusLines = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout
      .split("\n").filter(Boolean)
      .filter((line) => {
        const rawPath = line.slice(3).trim();
        const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
        return path !== ".atelier" && !path.startsWith(".atelier/");
      });
    const changed = statusLines.map((line) => line.slice(3).trim())
      .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) ?? path : path);
    const contentState = changed.map((path) => {
      const absolute = resolve(root, path);
      if (!existsSync(absolute)) return `${path}:deleted`;
      try {
        const stat = statSync(absolute);
        return stat.isFile() ? `${path}:${stat.size}:${sha256(readFileSync(absolute))}` : `${path}:non-file`;
      } catch { return `${path}:unreadable`; }
    }).join("\0");
    const fingerprint = sha256(`${head.stdout.trim()}\0${statusLines.join("\n")}\0${contentState}`);
    return {
      repositoryId: `git:${sha256(`${root}\0${commonDir.stdout.trim()}`).slice(0, 24)}`,
      workspaceId: sha256(root).slice(0, 16),
      vcs: "git",
      headCommit: head.status === 0 ? head.stdout.trim() : "unborn",
      dirtyGeneration: this.dirtyGeneration(fingerprint),
      dirtyFingerprint: fingerprint,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  changedPaths(): string[] {
    const result = runGit(this.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (result.status !== 0) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) ?? path : path);
  }

  listFiles(): string[] {
    const result = runGit(this.cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (result.status !== 0) return [];
    return result.stdout.split("\n").map((path) => path.trim()).filter(Boolean)
      .filter((path) => path !== ".atelier" && !path.startsWith(".atelier/")).sort();
  }

  diff(path?: string): string {
    const args = ["diff", "--no-ext-diff", "--"];
    if (path !== undefined) args.push(path);
    const result = runGit(this.cwd, args);
    return result.status === 0 ? result.stdout : "";
  }

  private dirtyGeneration(fingerprint: string): number {
    const key = "repositoryDirtyState:git";
    const state = this.ledger.getState<{ fingerprint: string; generation: number }>(key);
    if (state === undefined) {
      this.ledger.setState(key, { fingerprint, generation: 0 });
      return 0;
    }
    if (state.fingerprint === fingerprint) return state.generation;
    const next = state.generation + 1;
    this.ledger.setState(key, { fingerprint, generation: next });
    return next;
  }
}
