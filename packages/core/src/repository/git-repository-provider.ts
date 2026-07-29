import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { RepositoryCommitResult, RepositoryProvider, RepositoryProviderStatus } from "./repository-provider.ts";
import { RepositoryObservationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";
import { isSourcePath } from "./source-path.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function revision(reference: string): string {
  return reference === "unborn" ? EMPTY_TREE : reference;
}

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

function requiredGit(cwd: string, args: string[], purpose: string): GitResult {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new RepositoryObservationError(`Git ${purpose} failed: ${result.stderr.trim() || `exit ${result.status}`}`, {
      cwd,
      command: ["git", ...args],
      status: result.status,
    });
  }
  return result;
}

function parseStatusPaths(stdout: string): string[] {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const raw = line.slice(3).trim();
    return raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
  });
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


export class GitRepositoryProvider implements RepositoryProvider {
  readonly name = "git" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly indexSchemaVersion: number;
  private readonly stateKey: string;

  constructor(options: { cwd: string; ledger: SqliteLedger; indexSchemaVersion?: number }) {
    this.cwd = resolve(options.cwd);
    this.ledger = options.ledger;
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.stateKey = `repositoryDirtyState:git:${sha256(this.cwd).slice(0, 16)}`;
  }

  status(): RepositoryProviderStatus {
    const version = runGit(this.cwd, ["--version"]);
    if (version.status !== 0) return { provider: "git", available: false, repository: false, reason: version.stderr.trim() || "git is unavailable" };
    const root = runGit(this.cwd, ["rev-parse", "--show-toplevel"]);
    return { provider: "git", available: true, repository: root.status === 0, ...(root.status === 0 ? {} : { reason: root.stderr.trim() || "not a Git repository" }) };
  }

  snapshot(): RepositorySnapshot {
    const root = requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim();
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const commonDir = requiredGit(root, ["rev-parse", "--git-common-dir"], "common-directory observation");
    const status = requiredGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], "working-copy observation");
    const rawStatusLines = status.stdout.split("\n").filter(Boolean);
    const rawChanged = parseStatusPaths(`${rawStatusLines.join("\n")}\n`);
    const sourceStatusLines = rawStatusLines.filter((line) => isSourcePath(parseStatusPaths(`${line}\n`)[0] ?? ""));
    const sourceChanged = parseStatusPaths(`${sourceStatusLines.join("\n")}\n`);
    const sourceBaseCommit = head.status === 0 ? head.stdout.trim() : "unborn";
    const sourceFingerprint = sha256(
      `${sourceBaseCommit}\0${sourceStatusLines.join("\n")}\0${contentState(root, sourceChanged, true)}`,
    );
    const rawFingerprint = sha256(
      `${sourceBaseCommit}\0${rawStatusLines.join("\n")}\0${sourceFingerprint}\0${contentState(root, rawChanged, false)}`,
    );
    return {
      repositoryId: `git:${sha256(`${root}\0${commonDir.stdout.trim()}`).slice(0, 24)}`,
      workspaceId: sha256(root).slice(0, 16),
      vcs: "git",
      headCommit: sourceBaseCommit,
      sourceBaseCommit,
      sourceFingerprint,
      dirtyGeneration: this.dirtyGeneration(rawFingerprint),
      dirtyFingerprint: rawFingerprint,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  changedPaths(): string[] {
    const result = requiredGit(this.cwd, ["status", "--porcelain=v1", "--untracked-files=all"], "changed-path observation");
    return parseStatusPaths(result.stdout).filter(isSourcePath).sort();
  }

  changedPathsFrom(reference: string): string[] {
    const result = requiredGit(this.cwd, ["diff", "--name-only", revision(reference), "--"], `changed paths from ${reference}`);
    return [...new Set([
      ...result.stdout.split("\n").map((path) => path.trim()).filter(Boolean),
      ...this.untrackedPaths(),
    ])].filter(isSourcePath).sort();
  }

  listFiles(): string[] {
    const result = requiredGit(this.cwd, ["ls-files", "--cached", "--others", "--exclude-standard"], "file inventory");
    return result.stdout.split("\n").map((path) => path.trim()).filter(Boolean).filter(isSourcePath).sort();
  }

  diff(path?: string): string {
    const suffix = path === undefined ? [] : [path];
    const working = requiredGit(this.cwd, ["diff", "--no-ext-diff", "--", ...suffix], "working-tree diff").stdout;
    const staged = requiredGit(this.cwd, ["diff", "--cached", "--no-ext-diff", "--", ...suffix], "staged diff").stdout;
    return [
      staged.trim() ? `# Staged changes\n${staged}` : "",
      working.trim() ? `# Unstaged changes\n${working}` : "",
    ].filter(Boolean).join("\n");
  }

  diffFrom(reference: string, path?: string): string {
    const suffix = path === undefined ? [] : [path];
    const tracked = requiredGit(this.cwd, ["diff", "--no-ext-diff", revision(reference), "--", ...suffix], `diff from ${reference}`).stdout;
    const untracked = this.untrackedPaths()
      .filter((candidate) => path === undefined || candidate === path || candidate.startsWith(`${path}/`))
      .map((candidate) => {
        const result = runGit(this.cwd, ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", candidate]);
        if (result.status !== 0 && result.status !== 1) {
          throw new RepositoryObservationError(`Git untracked diff failed: ${result.stderr.trim() || `exit ${result.status}`}`, {
            cwd: this.cwd,
            command: ["git", "diff", "--no-index", "--no-ext-diff", "--", "/dev/null", candidate],
            status: result.status,
          });
        }
        return result.stdout;
      })
      .filter(Boolean);
    return [tracked, ...untracked].filter((value) => value.trim().length > 0).join("\n");
  }

  commit(message: string, paths?: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Commit message cannot be empty.");
    const changed = (paths ?? this.changedPaths()).filter(isSourcePath);
    if (changed.length === 0) throw new Error("No repository changes are available to commit.");
    requiredGit(this.cwd, ["add", "-A", "--", ...changed], "staging");
    // Keep workflow/provider metadata and unrelated pre-staged changes out of
    // the approved task commit. Git pathspec commits record only the reviewed
    // source paths while leaving any other index entries staged for separate
    // handling.
    requiredGit(this.cwd, ["commit", "-m", normalized, "--", ...changed], "scoped local commit");
    return { message: normalized, changedPaths: changed, snapshot: this.snapshot() };
  }

  private dirtyGeneration(fingerprint: string): number {
    const state = this.ledger.getState<{ fingerprint: string; generation: number }>(this.stateKey);
    if (state === undefined) {
      this.ledger.setState(this.stateKey, { fingerprint, generation: 0 });
      return 0;
    }
    if (state.fingerprint === fingerprint) return state.generation;
    const next = state.generation + 1;
    this.ledger.setState(this.stateKey, { fingerprint, generation: next });
    return next;
  }

  private untrackedPaths(): string[] {
    const result = requiredGit(this.cwd, ["ls-files", "--others", "--exclude-standard"], "untracked-file observation");
    return result.stdout.split("\n").map((path) => path.trim()).filter(Boolean).filter(isSourcePath).sort();
  }
}
