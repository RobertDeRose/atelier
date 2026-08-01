import { spawnSync } from "node:child_process";
import { minimalEnvironment } from "../process/environment.ts";
import { runProcess, type ProcessResult } from "../process/async-process.ts";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type {
  RepositoryCommitResult,
  RepositoryDisplayState,
  RepositoryObservation,
  RepositoryObserveOptions,
  RepositoryPathState,
  RepositoryProvider,
  RepositoryProviderStatus,
  RepositoryRecoveryState,
} from "./repository-provider.ts";
import { RepositoryObservationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";
import { nowIso } from "../util/ids.ts";
import { isSourcePath } from "./source-path.ts";
import { resolveAccessPath } from "../security/path-boundary.ts";
import {
  canonicalRepositoryRoot,
  repositoryPathTarget,
  repositoryPathTargets,
  repositoryPathspecs,
} from "./repository-path.ts";

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

function asyncFailure(result: ProcessResult): string {
  if (result.timedOut) return "timed out";
  if (result.aborted) return "cancelled";
  return result.stderr.trim() || `exit ${result.exitCode}`;
}

function hashChangedContents(root: string, paths: readonly string[]): { value: string; files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const value = [...new Set(paths)].sort().map((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return `${path}:deleted`;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return `${path}:non-file:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
      const content = readFileSync(absolute);
      files += 1;
      bytes += content.byteLength;
      return `${path}:${stat.mode}:${content.byteLength}:${sha256(content)}`;
    } catch {
      return `${path}:unreadable`;
    }
  }).join("\0");
  return { value, files, bytes };
}



export class GitRepositoryProvider implements RepositoryProvider {
  readonly name = "git" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly indexSchemaVersion: number;
  private readonly stateKey: string;
  private rootPromise?: Promise<string>;
  private commonDirectoryPromise?: Promise<string>;
  private observationPromise?: { generation: number; promise: Promise<RepositoryObservation> };
  private lastObservation?: RepositoryObservation;
  private observationGeneration = 0;

  constructor(options: { cwd: string; ledger: SqliteLedger; indexSchemaVersion?: number }) {
    this.cwd = canonicalRepositoryRoot(options.cwd);
    this.ledger = options.ledger;
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.stateKey = `repositoryDirtyState:git:${sha256(this.cwd).slice(0, 16)}`;
  }

  peekObservation(): RepositoryObservation | undefined {
    return this.lastObservation;
  }

  invalidateObservation(): void {
    this.observationGeneration += 1;
    delete this.lastObservation;
    delete this.observationPromise;
  }

  async observe(options: RepositoryObserveOptions = {}): Promise<RepositoryObservation> {
    const cached = this.lastObservation;
    const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(cached.observedAt);
    const requested = repositoryPathTargets(this.cwd, options.paths ?? [], "write").map((target) => target.key);
    const hasRequestedStates = requested.every((path) => cached?.pathStates[path] !== undefined);
    if (!options.force && cached !== undefined && age <= 250 && (!options.includeFiles || cached.files !== undefined) && hasRequestedStates) {
      return { ...cached, metrics: { ...cached.metrics, cacheHit: true, durationMs: 0, subprocesses: 0, filesHashed: 0, bytesHashed: 0 } };
    }
    const generation = this.observationGeneration;
    if (
      this.observationPromise !== undefined
      && this.observationPromise.generation === generation
      && requested.length === 0
      && options.includeFiles !== true
    ) return this.observationPromise.promise;
    const pending = this.observeFresh(options);
    if (requested.length === 0 && options.includeFiles !== true) this.observationPromise = { generation, promise: pending };
    try {
      const observation = await pending;
      if (generation === this.observationGeneration) this.lastObservation = observation;
      return observation;
    } finally {
      if (this.observationPromise?.promise === pending) delete this.observationPromise;
    }
  }

  async classifyPaths(paths: readonly string[], options: { signal?: AbortSignal } = {}): Promise<Record<string, RepositoryPathState>> {
    const root = await this.repositoryRoot(options.signal);
    const targets = repositoryPathTargets(root, paths, "write");
    const relativePaths = [...new Set(targets.map((target) => target.relative))];
    const trackedResult = await runProcess("git", ["ls-files", "-z", "--", ...relativePaths], {
      cwd: root,
      signal: options.signal,
      timeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      maxOutputBytes: 256 * 1024,
    });
    if (trackedResult.exitCode !== 0) throw new RepositoryObservationError(`Git path inventory failed: ${asyncFailure(trackedResult)}`);
    const tracked = new Set(trackedResult.stdout.split("\0").filter(Boolean));
    const ignoredResult = await runProcess("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      input: `${relativePaths.join("\0")}\0`,
      signal: options.signal,
      timeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      maxOutputBytes: 256 * 1024,
    });
    const ignored = new Set(ignoredResult.stdout.split("\0").filter(Boolean));
    const statusResult = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...relativePaths], {
      cwd: root,
      signal: options.signal,
      timeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      maxOutputBytes: 256 * 1024,
    });
    if (statusResult.exitCode !== 0) throw new RepositoryObservationError(`Git path-state observation failed: ${asyncFailure(statusResult)}`);
    const dirty = new Set(parseStatusPaths(statusResult.stdout));
    return Object.fromEntries(targets.flatMap((target) => {
      const rel = target.relative;
      const state: RepositoryPathState = tracked.has(rel)
        ? dirty.has(rel) ? "tracked_dirty" : "tracked_clean"
        : ignored.has(rel) ? "ignored"
          : existsSync(target.absolute) ? "untracked" : "missing";
      return [...new Set([target.key, target.entry])]
        .map((path) => [path, state] as const);
    }));
  }

  private async repositoryRoot(signal?: AbortSignal): Promise<string> {
    if (this.rootPromise !== undefined) return this.rootPromise;
    const pending = runProcess("git", ["rev-parse", "--show-toplevel"], {
      cwd: this.cwd,
      signal,
      timeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      maxOutputBytes: 64 * 1024,
    }).then((result) => {
      if (result.exitCode !== 0) throw new RepositoryObservationError(`Git repository-root observation failed: ${asyncFailure(result)}`);
      return resolveAccessPath(result.stdout.trim(), "read");
    });
    this.rootPromise = pending;
    pending.catch(() => { if (this.rootPromise === pending) delete this.rootPromise; });
    return pending;
  }

  private async commonDirectory(root: string, signal?: AbortSignal): Promise<string> {
    if (this.commonDirectoryPromise !== undefined) return this.commonDirectoryPromise;
    const pending = runProcess("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      signal,
      timeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      maxOutputBytes: 64 * 1024,
    }).then((result) => {
      if (result.exitCode !== 0) throw new RepositoryObservationError(`Git common-directory observation failed: ${asyncFailure(result)}`);
      return resolveAccessPath(result.stdout.trim(), "read", root);
    });
    this.commonDirectoryPromise = pending;
    pending.catch(() => { if (this.commonDirectoryPromise === pending) delete this.commonDirectoryPromise; });
    return pending;
  }

  private async observeFresh(options: RepositoryObserveOptions): Promise<RepositoryObservation> {
    const started = performance.now();
    let subprocesses = 0;
    const run = async (args: string[], purpose: string, allowFailure = false): Promise<ProcessResult> => {
      subprocesses += 1;
      const result = await runProcess("git", args, {
        cwd: await this.repositoryRoot(options.signal),
        signal: options.signal,
        timeoutMs: 15_000,
        idleTimeoutMs: 5_000,
        maxOutputBytes: 512 * 1024,
      });
      if (!allowFailure && result.exitCode !== 0) throw new RepositoryObservationError(`Git ${purpose} failed: ${asyncFailure(result)}`);
      return result;
    };
    const root = await this.repositoryRoot(options.signal);
    subprocesses += 1; // root observation (cached promises are intentionally counted only on cache misses by caller metrics)
    const commonDir = await this.commonDirectory(root, options.signal);
    subprocesses += 1;
    const [statusResult, headResult, branchResult] = await Promise.all([
      run(["status", "--porcelain=v1", "--untracked-files=all"], "working-copy observation"),
      run(["rev-parse", "HEAD"], "head observation", true),
      run(["symbolic-ref", "--quiet", "--short", "HEAD"], "branch observation", true),
    ]);
    const rawChangedPaths = parseStatusPaths(statusResult.stdout).sort();
    const changedPaths = rawChangedPaths.filter(isSourcePath);
    const sourceBaseCommit = headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn";
    const sourceContents = hashChangedContents(root, changedPaths);
    const rawContents = hashChangedContents(root, rawChangedPaths.filter((path) => !changedPaths.includes(path)));
    const sourceFingerprint = sha256(`${sourceBaseCommit}\0${changedPaths.join("\0")}\0${sourceContents.value}`);
    const rawFingerprint = sha256(`${sourceBaseCommit}\0${statusResult.stdout}\0${sourceFingerprint}\0${rawContents.value}`);
    const conflicts = statusResult.stdout.split("\n").filter(Boolean).some((line) => {
      const code = line.slice(0, 2);
      return code.includes("U") || code === "AA" || code === "DD";
    });
    let files: string[] | undefined;
    if (options.includeFiles) {
      const fileResult = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], "file inventory");
      files = fileResult.stdout.split("\0").filter(Boolean).filter(isSourcePath).sort();
    }
    const pathStates = (options.paths?.length ?? 0) > 0
      ? await this.classifyPaths(options.paths!, options.signal === undefined ? {} : { signal: options.signal })
      : {};
    if ((options.paths?.length ?? 0) > 0) subprocesses += 3;
    const snapshot: RepositorySnapshot = {
      repositoryId: `git:${sha256(`${root}\0${commonDir}`).slice(0, 24)}`,
      workspaceId: sha256(root).slice(0, 16),
      vcs: "git",
      headCommit: sourceBaseCommit,
      sourceBaseCommit,
      sourceFingerprint,
      dirtyGeneration: this.dirtyGeneration(rawFingerprint),
      dirtyFingerprint: rawFingerprint,
      indexSchemaVersion: this.indexSchemaVersion,
    };
    return {
      status: { provider: "git", available: true, repository: true },
      snapshot,
      displayState: {
        vcs: "git",
        ...(branchResult.exitCode === 0 && branchResult.stdout.trim() ? { label: branchResult.stdout.trim() } : {}),
        ...(sourceBaseCommit === "unborn" ? {} : { revision: sourceBaseCommit.slice(0, 8) }),
        state: conflicts ? "conflicted" : rawChangedPaths.length > 0 ? "dirty" : "clean",
        ...(branchResult.exitCode === 0 ? {} : { detached: true }),
      },
      root,
      rawChangedPaths,
      changedPaths,
      ...(files === undefined ? {} : { files }),
      pathStates,
      observedAt: nowIso(),
      metrics: {
        durationMs: performance.now() - started,
        subprocesses,
        filesHashed: sourceContents.files + rawContents.files,
        bytesHashed: sourceContents.bytes + rawContents.bytes,
        cacheHit: false,
      },
    };
  }

  status(): RepositoryProviderStatus {
    const version = runGit(this.cwd, ["--version"]);
    if (version.status !== 0) return { provider: "git", available: false, repository: false, reason: version.stderr.trim() || "git is unavailable" };
    const root = runGit(this.cwd, ["rev-parse", "--show-toplevel"]);
    return { provider: "git", available: true, repository: root.status === 0, ...(root.status === 0 ? {} : { reason: root.stderr.trim() || "not a Git repository" }) };
  }

  snapshot(): RepositorySnapshot {
    const root = canonicalRepositoryRoot(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim());
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
      repositoryId: `git:${sha256(`${root}\0${resolveAccessPath(commonDir.stdout.trim(), "read", root)}`).slice(0, 24)}`,
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

  displayState(): RepositoryDisplayState {
    const root = canonicalRepositoryRoot(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim());
    const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const head = runGit(root, ["rev-parse", "--short=8", "HEAD"]);
    const status = requiredGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], "display-state observation");
    const lines = status.stdout.split("\n").filter(Boolean);
    const conflicted = lines.some((line) => {
      const code = line.slice(0, 2);
      return code.includes("U") || code === "AA" || code === "DD";
    });
    return {
      vcs: "git",
      ...(branch.status === 0 && branch.stdout.trim() ? { label: branch.stdout.trim() } : {}),
      ...(head.status === 0 && head.stdout.trim() ? { revision: head.stdout.trim() } : {}),
      state: conflicted ? "conflicted" : lines.length > 0 ? "dirty" : "clean",
      ...(branch.status === 0 ? {} : { detached: true }),
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
    const root = canonicalRepositoryRoot(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim());
    const target = repositoryPathTarget(root, path, "write");
    const relativePath = target.relative;
    const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", relativePath]);
    if (tracked.status === 0) {
      const status = requiredGit(root, ["status", "--porcelain=v1", "--", relativePath], "path-state observation");
      return status.stdout.trim() ? "tracked_dirty" : "tracked_clean";
    }
    const ignored = runGit(root, ["check-ignore", "-q", "--", relativePath]);
    if (ignored.status === 0) return "ignored";
    return existsSync(target.absolute) ? "untracked" : "missing";
  }

  captureRecoveryState(paths: string[]): RepositoryRecoveryState {
    const root = canonicalRepositoryRoot(requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim());
    const relativePaths = repositoryPathspecs(root, paths, "write");
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
    const root = canonicalRepositoryRoot(String(state.native.root));
    const currentRoot = canonicalRepositoryRoot(
      requiredGit(this.cwd, ["rev-parse", "--show-toplevel"], "repository-root observation").stdout.trim(),
    );
    if (root !== currentRoot) throw new Error(`Git recovery state belongs to a different repository: ${root}`);
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
    const suffix = path === undefined ? [] : repositoryPathspecs(this.cwd, [path], "read");
    const working = requiredGit(this.cwd, ["diff", "--no-ext-diff", "--", ...suffix], "working-tree diff").stdout;
    const staged = requiredGit(this.cwd, ["diff", "--cached", "--no-ext-diff", "--", ...suffix], "staged diff").stdout;
    return [
      staged.trim() ? `# Staged changes\n${staged}` : "",
      working.trim() ? `# Unstaged changes\n${working}` : "",
    ].filter(Boolean).join("\n");
  }

  diffFrom(reference: string, path?: string): string {
    const suffix = path === undefined ? [] : repositoryPathspecs(this.cwd, [path], "read");
    const scopedPath = suffix[0];
    const tracked = requiredGit(this.cwd, ["diff", "--no-ext-diff", revision(reference), "--", ...suffix], `diff from ${reference}`).stdout;
    const untracked = this.untrackedPaths()
      .filter((candidate) => scopedPath === undefined || candidate === scopedPath || candidate.startsWith(`${scopedPath}/`))
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
    const changed = paths === undefined
      ? this.changedPaths()
      : repositoryPathspecs(this.cwd, paths, "write").filter(isSourcePath);
    if (changed.length === 0) throw new Error("No repository changes are available to commit.");
    requiredGit(this.cwd, ["add", "-A", "--", ...changed], "staging");
    // Keep workflow/provider metadata and unrelated pre-staged changes out of
    // the approved task commit. Git pathspec commits record only the reviewed
    // source paths while leaving any other index entries staged for separate
    // handling.
    // Atelier intentionally strips signing-agent credentials from child
    // processes. Disable signing explicitly so a workstation-level
    // commit.gpgSign=true setting cannot make a reviewed local commit fail or
    // prompt outside Atelier's authorization boundary.
    requiredGit(this.cwd, ["commit", "--no-gpg-sign", "-m", normalized, "--", ...changed], "scoped local commit");
    return { message: normalized, changedPaths: changed, snapshot: this.snapshot() };
  }

  commitMetadata(message: string, paths: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Metadata commit message cannot be empty.");
    const changed = repositoryPathspecs(this.cwd, paths, "write").sort();
    if (changed.length === 0) throw new Error("No workflow metadata changes are available to commit.");
    requiredGit(this.cwd, ["add", "-A", "--", ...changed], "workflow metadata staging");
    requiredGit(this.cwd, ["commit", "--no-gpg-sign", "-m", normalized, "--", ...changed], "workflow metadata commit");
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
