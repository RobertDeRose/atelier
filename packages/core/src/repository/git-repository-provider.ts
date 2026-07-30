import { spawnSync } from "node:child_process";
import { minimalEnvironment } from "../process/environment.ts";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { RepositoryCommitResult, RepositoryPathState, RepositoryProvider, RepositoryProviderStatus, RepositoryRecoveryState } from "./repository-provider.ts";
import { RepositoryObservationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";
import { isSourcePath } from "./source-path.ts";
import { resolveAccessPath } from "../security/path-boundary.ts";

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
    env: minimalEnvironment(),
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

function runGitInput(cwd: string, args: string[], input: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    env: minimalEnvironment(),
    encoding: "utf8",
    input,
    shell: false,
    windowsHide: true,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
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
    const sourceBaseCommit = head.status === 0 ? head.stdout.trim() : "unborn";
    const sourceFiles = this.listFiles();
    const sourceFingerprint = sha256(
      `${sourceFiles.join("\0")}\0${contentState(root, sourceFiles, true)}`,
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
    return this.rawChangedPaths().filter(isSourcePath);
  }

  rawChangedPaths(): string[] {
    const result = requiredGit(this.cwd, ["status", "--porcelain=v1", "--untracked-files=all"], "changed-path observation");
    return parseStatusPaths(result.stdout).sort();
  }

  changedPathsFrom(reference: string): string[] {
    const result = requiredGit(this.cwd, ["diff", "--name-only", revision(reference), "--"], `changed paths from ${reference}`);
    return [...new Set([
      ...result.stdout.split("\n").map((path) => path.trim()).filter(Boolean),
      ...this.untrackedPaths(),
    ])].filter(isSourcePath).sort();
  }

  classifyPath(path: string): RepositoryPathState {
    const root = resolveAccessPath(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim(), "read");
    const absolute = resolveAccessPath(path, "write");
    const relativePath = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
    const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", relativePath]);
    if (tracked.status === 0) {
      const status = requiredGit(root, ["status", "--porcelain=v1", "--", relativePath], "path-state observation");
      return status.stdout.trim() ? "tracked_dirty" : "tracked_clean";
    }
    const ignored = runGit(root, ["check-ignore", "-q", "--", relativePath]);
    if (ignored.status === 0) return "ignored";
    return existsSync(absolute) ? "untracked" : "missing";
  }

  captureRecoveryState(paths: string[]): RepositoryRecoveryState {
    const root = resolveAccessPath(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim(), "read");
    const relativePaths = paths.map((path) => {
      const absolute = resolveAccessPath(path, "write");
      if (absolute === root) return ".";
      if (!absolute.startsWith(`${root}/`)) throw new Error(`Git recovery path is outside the repository: ${absolute}`);
      return absolute.slice(root.length + 1);
    });
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const headCommit = head.status === 0 ? head.stdout.trim() : "unborn";
    const index = requiredGit(root, ["ls-files", "--stage", "-z", "--", ...relativePaths], "recovery index capture").stdout;
    const flags = requiredGit(root, ["ls-files", "-v", "-z", "--", ...relativePaths], "recovery index flag capture").stdout;
    const status = requiredGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...relativePaths], "recovery status capture").stdout;
    return {
      provider: "git",
      native: {
        root,
        relativePaths,
        headCommit,
        index: Buffer.from(index, "utf8").toString("base64"),
        flags: Buffer.from(flags, "utf8").toString("base64"),
        status: Buffer.from(status, "utf8").toString("base64"),
      },
    };
  }

  restoreRecoveryState(state: RepositoryRecoveryState, paths: string[]): void {
    if (state.provider !== "git" || state.native === undefined) throw new Error("Git recovery state is unavailable.");
    const root = String(state.native.root);
    const relativePaths = Array.isArray(state.native.relativePaths) ? state.native.relativePaths.map(String) : [];
    if (relativePaths.length === 0) return;
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const currentHead = head.status === 0 ? head.stdout.trim() : "unborn";
    const expectedHead = String(state.native.headCommit ?? "unborn");
    if (currentHead !== expectedHead) {
      throw new Error(`Git HEAD changed from ${expectedHead} to ${currentHead}; exact checkpoint restoration is unsafe.`);
    }
    requiredGit(root, ["update-index", "--force-remove", "--", ...relativePaths], "recovery index reset");
    const index = Buffer.from(String(state.native.index ?? ""), "base64").toString("utf8");
    if (index.length > 0) {
      const restored = runGitInput(root, ["update-index", "-z", "--index-info"], index);
      if (restored.status !== 0) throw new RepositoryObservationError(`Git recovery index restore failed: ${restored.stderr.trim() || `exit ${restored.status}`}`);
    }
    const flags = Buffer.from(String(state.native.flags ?? ""), "base64").toString("utf8").split("\0").filter(Boolean);
    for (const record of flags) {
      const flag = record[0];
      const path = record.slice(2);
      if (flag === "S") requiredGit(root, ["update-index", "--skip-worktree", "--", path], "skip-worktree flag restore");
      if (flag === "h") requiredGit(root, ["update-index", "--assume-unchanged", "--", path], "assume-unchanged flag restore");
    }
    this.verifyRecoveryState(state, paths);
  }

  verifyRecoveryState(state: RepositoryRecoveryState, paths: string[]): void {
    if (state.provider !== "git" || state.native === undefined) throw new Error("Git recovery state is unavailable.");
    const current = this.captureRecoveryState(paths);
    for (const field of ["root", "headCommit", "index", "flags", "status"] as const) {
      if (current.native?.[field] !== state.native[field]) {
        throw new Error(`Git recovery checkpoint verification failed for ${field}.`);
      }
    }
    const expectedPaths = JSON.stringify(state.native.relativePaths ?? []);
    const actualPaths = JSON.stringify(current.native?.relativePaths ?? []);
    if (actualPaths !== expectedPaths) throw new Error("Git recovery checkpoint verification failed for path scope.");
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

  commitMetadata(message: string, paths: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Metadata commit message cannot be empty.");
    const changed = [...new Set(paths)].sort();
    if (changed.length === 0) throw new Error("No workflow metadata changes are available to commit.");
    requiredGit(this.cwd, ["add", "-A", "--", ...changed], "workflow metadata staging");
    requiredGit(this.cwd, ["commit", "-m", normalized, "--", ...changed], "workflow metadata commit");
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
