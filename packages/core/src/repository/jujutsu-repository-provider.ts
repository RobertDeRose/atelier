import { spawnSync } from "node:child_process";
import { minimalEnvironment } from "../process/environment.ts";
import { runProcess, type ProcessResult } from "../process/async-process.ts";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { RepositoryObservationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";
import { nowIso } from "../util/ids.ts";
import { isSourcePath } from "./source-path.ts";
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
import { resolveAccessPath } from "../security/path-boundary.ts";
import {
  canonicalRepositoryRoot,
  repositoryPathTarget,
  repositoryPathTargets,
  repositoryPathspecs,
} from "./repository-path.ts";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(executable: string, cwd: string, args: string[]): CommandResult {
  const result = spawnSync(executable, args, {
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



export class JujutsuRepositoryProvider implements RepositoryProvider {
  readonly name = "jj" as const;
  private readonly cwd: string;
  private readonly ledger: SqliteLedger;
  private readonly executable: string;
  private readonly indexSchemaVersion: number;
  private readonly stateKey: string;
  private rootPromise?: Promise<string>;
  private workspaceRootPromise?: Promise<string>;
  private observationPromise?: { generation: number; promise: Promise<RepositoryObservation> };
  private lastObservation?: RepositoryObservation;
  private observationGeneration = 0;

  constructor(options: {
    cwd: string;
    ledger: SqliteLedger;
    executable?: string;
    indexSchemaVersion?: number;
  }) {
    this.cwd = canonicalRepositoryRoot(options.cwd);
    this.ledger = options.ledger;
    this.executable = options.executable ?? "jj";
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.stateKey = `repositoryDirtyState:jj:${sha256(this.cwd).slice(0, 16)}`;
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
    const [listedResult, changedResult, ignoredResult] = await Promise.all([
      runProcess(this.executable, ["file", "list", ...relativePaths], {
        cwd: root, signal: options.signal, timeoutMs: 10_000, idleTimeoutMs: 3_000, maxOutputBytes: 256 * 1024,
      }),
      runProcess(this.executable, ["diff", "--name-only", "--color", "never", "--", ...relativePaths], {
        cwd: root, signal: options.signal, timeoutMs: 10_000, idleTimeoutMs: 3_000, maxOutputBytes: 256 * 1024,
      }),
      runProcess("git", ["check-ignore", "-z", "--stdin"], {
        cwd: root, input: `${relativePaths.join("\0")}\0`, signal: options.signal,
        timeoutMs: 10_000, idleTimeoutMs: 3_000, maxOutputBytes: 256 * 1024,
      }),
    ]);
    if (listedResult.exitCode !== 0) throw new RepositoryObservationError(`Jujutsu path inventory failed: ${asyncFailure(listedResult)}`);
    if (changedResult.exitCode !== 0) throw new RepositoryObservationError(`Jujutsu path-state observation failed: ${asyncFailure(changedResult)}`);
    const listed = new Set(lines(listedResult.stdout));
    const changed = new Set(lines(changedResult.stdout));
    const ignored = new Set(ignoredResult.stdout.split("\0").filter(Boolean));
    return Object.fromEntries(targets.flatMap((target) => {
      const rel = target.relative;
      const state: RepositoryPathState = listed.has(rel)
        ? changed.has(rel) ? "tracked_dirty" : "tracked_clean"
        : ignored.has(rel) ? "ignored"
          : existsSync(target.absolute) ? "untracked" : "missing";
      return [...new Set([target.key, target.entry])]
        .map((path) => [path, state] as const);
    }));
  }

  private async repositoryRoot(signal?: AbortSignal): Promise<string> {
    if (this.rootPromise !== undefined) return this.rootPromise;
    const pending = runProcess(this.executable, ["root"], {
      cwd: this.cwd, signal, timeoutMs: 10_000, idleTimeoutMs: 3_000, maxOutputBytes: 64 * 1024,
    }).then((result) => {
      if (result.exitCode !== 0) throw new RepositoryObservationError(`Jujutsu repository-root observation failed: ${asyncFailure(result)}`);
      return resolveAccessPath(result.stdout.trim(), "read");
    });
    this.rootPromise = pending;
    pending.catch(() => { if (this.rootPromise === pending) delete this.rootPromise; });
    return pending;
  }

  private async workspaceRoot(root: string, signal?: AbortSignal): Promise<string> {
    if (this.workspaceRootPromise !== undefined) return this.workspaceRootPromise;
    const pending = runProcess(this.executable, ["workspace", "root"], {
      cwd: root, signal, timeoutMs: 10_000, idleTimeoutMs: 3_000, maxOutputBytes: 64 * 1024,
    }).then((result) => {
      if (result.exitCode !== 0) throw new RepositoryObservationError(`Jujutsu workspace-root observation failed: ${asyncFailure(result)}`);
      return resolveAccessPath(result.stdout.trim(), "read");
    });
    this.workspaceRootPromise = pending;
    pending.catch(() => { if (this.workspaceRootPromise === pending) delete this.workspaceRootPromise; });
    return pending;
  }

  private async observeFresh(options: RepositoryObserveOptions): Promise<RepositoryObservation> {
    const started = performance.now();
    let subprocesses = 0;
    const root = await this.repositoryRoot(options.signal);
    subprocesses += 1;
    const runAsync = async (args: string[], purpose: string, allowFailure = false): Promise<ProcessResult> => {
      subprocesses += 1;
      const result = await runProcess(this.executable, args, {
        cwd: root, signal: options.signal, timeoutMs: 15_000, idleTimeoutMs: 5_000, maxOutputBytes: 512 * 1024,
      });
      if (!allowFailure && result.exitCode !== 0) throw new RepositoryObservationError(`Jujutsu ${purpose} failed: ${asyncFailure(result)}`);
      return result;
    };
    const workspaceRoot = await this.workspaceRoot(root, options.signal);
    subprocesses += 1;
    const [identity, parent, operation, bookmarks, conflicts, changed] = await Promise.all([
      runAsync(["log", "-r", "@", "--no-graph", "--color", "never", "-T", 'change_id ++ "\n" ++ commit_id ++ "\n"'], "change identity observation"),
      runAsync(["log", "-r", "@-", "--no-graph", "--color", "never", "-T", 'commit_id ++ "\n"'], "source-base observation"),
      runAsync(["op", "log", "--limit", "1", "--no-graph", "--color", "never", "-T", 'id ++ "\n"'], "operation identity observation"),
      runAsync(["bookmark", "list", "-r", "@", "--color", "never", "-T", 'name ++ "\n"'], "bookmark observation", true),
      runAsync(["resolve", "--list", "--color", "never"], "conflict observation", true),
      runAsync(["diff", "--name-only", "--color", "never"], "changed-path observation"),
    ]);
    const [changeId = "unknown", commitId = "unknown"] = lines(identity.stdout);
    const sourceBaseCommit = lines(parent.stdout)[0] ?? "unborn";
    const operationId = lines(operation.stdout)[0] ?? "unknown";
    const rawChangedPaths = lines(changed.stdout).sort();
    const changedPaths = rawChangedPaths.filter(isSourcePath);
    const sourceContents = hashChangedContents(root, changedPaths);
    const rawContents = hashChangedContents(root, rawChangedPaths.filter((path) => !changedPaths.includes(path)));
    const sourceFingerprint = sha256(`${sourceBaseCommit}\0${changedPaths.join("\0")}\0${sourceContents.value}`);
    const rawFingerprint = sha256(`${commitId}\0${changeId}\0${operationId}\0${rawChangedPaths.join("\0")}\0${sourceFingerprint}\0${rawContents.value}`);
    let files: string[] | undefined;
    if (options.includeFiles) {
      const fileResult = await runAsync(["file", "list"], "file inventory");
      files = lines(fileResult.stdout).filter(isSourcePath).sort();
    }
    const pathStates = (options.paths?.length ?? 0) > 0
      ? await this.classifyPaths(options.paths!, options.signal === undefined ? {} : { signal: options.signal })
      : {};
    if ((options.paths?.length ?? 0) > 0) subprocesses += 3;
    const snapshot: RepositorySnapshot = {
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
    const label = bookmarks.exitCode === 0 ? lines(bookmarks.stdout)[0] : undefined;
    return {
      status: { provider: "jj", available: true, repository: true },
      snapshot,
      displayState: {
        vcs: "jj",
        ...(label ? { label } : {}),
        ...(changeId !== "unknown" ? { revision: changeId.slice(0, 8) } : {}),
        state: conflicts.exitCode === 0 && conflicts.stdout.trim()
          ? "conflicted"
          : rawChangedPaths.length > 0 ? "dirty" : "clean",
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
    const root = canonicalRepositoryRoot(required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim());
    const workspaceRoot = canonicalRepositoryRoot(required(this.executable, this.cwd, ["workspace", "root"], "workspace-root observation").stdout.trim());
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

  displayState(): RepositoryDisplayState {
    const root = canonicalRepositoryRoot(required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim());
    const identity = lines(required(this.executable, root, [
      "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id.shortest(8) ++ "\\n"',
    ], "display identity observation").stdout)[0];
    const bookmarks = run(this.executable, root, [
      "bookmark", "list", "-r", "@", "--color", "never", "-T", 'name ++ "\\n"',
    ]);
    const label = bookmarks.status === 0 ? lines(bookmarks.stdout)[0] : undefined;
    const conflicts = run(this.executable, root, ["resolve", "--list", "--color", "never"]);
    const changed = this.observeRawChangedPaths();
    return {
      vcs: "jj",
      ...(label ? { label } : {}),
      ...(identity ? { revision: identity } : {}),
      state: conflicts.status === 0 && conflicts.stdout.trim()
        ? "conflicted"
        : changed.length > 0 ? "dirty" : "clean",
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
    if (path !== undefined) args.push("--", ...repositoryPathspecs(this.cwd, [path], "read"));
    return required(this.executable, this.cwd, args, "working-copy diff").stdout;
  }

  diffFrom(reference: string, path?: string): string {
    const args = ["diff", "--from", reference, "--to", "@", "--git", "--color", "never"];
    if (path !== undefined) args.push("--", ...repositoryPathspecs(this.cwd, [path], "read"));
    return required(this.executable, this.cwd, args, `diff from ${reference}`).stdout;
  }

  classifyPath(path: string): RepositoryPathState {
    const root = canonicalRepositoryRoot(required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim());
    const target = repositoryPathTarget(root, path, "write");
    const relativePath = target.relative;
    const listed = run(this.executable, root, ["file", "list", relativePath]);
    if (listed.status === 0 && lines(listed.stdout).includes(relativePath)) {
      return this.observeRawChangedPaths().includes(relativePath) ? "tracked_dirty" : "tracked_clean";
    }
    const ignored = spawnSync("git", ["check-ignore", "-q", "--", relativePath], { cwd: root, env: minimalEnvironment(), shell: false });
    if (ignored.status === 0) return "ignored";
    return existsSync(target.absolute) ? "untracked" : "missing";
  }

  captureRecoveryState(paths: string[]): RepositoryRecoveryState {
    const root = canonicalRepositoryRoot(required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim());
    // Reading @ snapshots the current working copy before the operation ID is
    // captured, making the operation log the exact recovery boundary.
    const identity = required(this.executable, root, [
      "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id ++ "\n" ++ commit_id ++ "\n"',
    ], "recovery working-copy capture");
    const [changeId = "", commitId = ""] = lines(identity.stdout);
    const operationId = required(this.executable, root, [
      "op", "log", "--limit", "1", "--no-graph", "--color", "never", "-T", 'id ++ "\n"',
    ], "recovery operation capture").stdout.trim();
    const relativePaths = repositoryPathspecs(root, paths, "write");
    return { provider: "jj", native: { root, changeId, commitId, operationId, relativePaths, restoreScope: "repository-operation" } };
  }

  restoreRecoveryState(state: RepositoryRecoveryState, paths: string[]): void {
    if (state.provider !== "jj" || state.native === undefined) throw new Error("Jujutsu recovery state is unavailable.");
    const root = canonicalRepositoryRoot(String(state.native.root));
    const currentRoot = canonicalRepositoryRoot(
      required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim(),
    );
    if (root !== currentRoot) throw new Error(`Jujutsu recovery state belongs to a different repository: ${root}`);
    const operationId = String(state.native.operationId ?? "");
    if (!operationId) throw new Error("Jujutsu recovery operation is missing.");
    required(this.executable, root, ["op", "restore", operationId], "recovery operation restore");
    const updated = run(this.executable, root, ["workspace", "update-stale"]);
    if (updated.status !== 0 && !/not stale|already.*current|up[- ]to[- ]date/i.test(updated.stderr)) {
      throw new RepositoryObservationError(`Jujutsu recovery workspace update failed: ${updated.stderr.trim() || `exit ${updated.status}`}`, {
        cwd: root,
        command: [this.executable, "workspace", "update-stale"],
        status: updated.status,
      });
    }
    this.verifyRecoveryState(state, paths);
  }

  verifyRecoveryState(state: RepositoryRecoveryState, _paths: string[]): void {
    if (state.provider !== "jj" || state.native === undefined) throw new Error("Jujutsu recovery state is unavailable.");
    const root = canonicalRepositoryRoot(String(state.native.root));
    const currentRoot = canonicalRepositoryRoot(
      required(this.executable, this.cwd, ["root"], "repository-root observation").stdout.trim(),
    );
    if (root !== currentRoot) throw new Error(`Jujutsu recovery state belongs to a different repository: ${root}`);
    const operationId = String(state.native.operationId ?? "");
    const expectedChange = String(state.native.changeId ?? "");
    const expectedCommit = String(state.native.commitId ?? "");
    if (!operationId || !expectedChange || !expectedCommit) throw new Error("Jujutsu recovery identity is incomplete.");
    const historical = required(this.executable, root, [
      `--at-op=${operationId}`, "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id ++ "\n" ++ commit_id ++ "\n"',
    ], "recovery operation verification");
    const [historicalChange = "", historicalCommit = ""] = lines(historical.stdout);
    if (historicalChange !== expectedChange || historicalCommit !== expectedCommit) {
      throw new Error("Jujutsu recovery checkpoint no longer resolves to the captured working-copy state.");
    }
    const current = required(this.executable, root, [
      "log", "-r", "@", "--no-graph", "--color", "never",
      "-T", 'change_id ++ "\n" ++ commit_id ++ "\n"',
    ], "recovery current-state verification");
    const [currentChange = "", currentCommit = ""] = lines(current.stdout);
    if (currentChange !== expectedChange || currentCommit !== expectedCommit) {
      throw new Error("Jujutsu recovery did not restore the captured working-copy commit.");
    }
  }

  listFiles(): string[] {
    const result = required(this.executable, this.cwd, ["file", "list"], "file inventory");
    return lines(result.stdout).filter(isSourcePath).sort();
  }

  commit(message: string, paths?: string[]): RepositoryCommitResult {
    const normalized = message.trim();
    if (!normalized) throw new Error("Change description cannot be empty.");
    const changed = paths === undefined
      ? this.changedPaths()
      : repositoryPathspecs(this.cwd, paths, "write").filter(isSourcePath);
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
    const changed = repositoryPathspecs(this.cwd, paths, "write").sort();
    if (changed.length === 0) throw new Error("No workflow metadata changes are available to finalize.");
    required(this.executable, this.cwd, ["commit", "-m", normalized, "--", ...changed], "workflow metadata change creation");
    return { message: normalized, changedPaths: changed, snapshot: this.snapshot() };
  }

  private observeRawChangedPaths(): string[] {
    const result = required(this.executable, this.cwd, ["diff", "--name-only", "--color", "never"], "changed-path observation");
    return lines(result.stdout).sort();
  }
}
