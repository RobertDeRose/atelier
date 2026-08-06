import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EvaluatedEffect } from "../policy/workspace-policy.ts";
import type { ExecutionBaseline } from "../domain/types.ts";
import { executionBaselineDigest } from "../workflow/execution-baseline.ts";
import type { RepositoryProvider, RepositoryRecoveryState } from "../repository/repository-provider.ts";
import { repositoryPathTarget, repositoryRelativePath } from "../repository/repository-path.ts";
import { resolveAccessEntryPath, resolveAccessPath, sameAccessPath } from "../security/path-boundary.ts";
import { newId } from "../util/ids.ts";

interface SnapshotEntry {
  path: string;
  kind: "missing" | "file" | "directory" | "symlink";
  mode?: number;
  target?: string;
  digest?: string;
  bytes?: number;
}

interface RecoveryManifest {
  version: 1;
  id: string;
  createdAt: string;
  workspaceRoot: string;
  paths: string[];
  entries: SnapshotEntry[];
  repositoryState: RepositoryRecoveryState;
  baseline?: ExecutionBaseline;
  toolCallId?: string;
  sessionId?: string;
  restoreCommand: string;
}

export interface RecoveryCheckpoint {
  id: string;
  directory: string;
  createdAt: string;
  paths: string[];
  repositoryState: RepositoryRecoveryState;
  baseline?: ExecutionBaseline;
  toolCallId?: string;
  sessionId?: string;
  restoreCommand: string;
}

const UNSUITABLE_CHECKPOINT_DIRECTORIES = new Set([
  ".git",
  ".jj",
  "node_modules",
  ".venv",
  "venv",
  "target",
  "build",
  "dist",
  ".cache",
  "__pycache__",
]);

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lexicalStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function lexicalExists(path: string): boolean {
  return lexicalStat(path) !== undefined;
}

export class RecoveryManager {
  readonly root: string;
  readonly directory: string;
  readonly maxBytes: number;
  readonly repository: RepositoryProvider;

  constructor(options: {
    workspaceRoot: string;
    runtimeDirectory: string;
    repository: RepositoryProvider;
    maxBytes?: number;
  }) {
    this.root = resolveAccessPath(options.workspaceRoot, "write");
    this.directory = join(resolveAccessPath(options.runtimeDirectory, "write"), "checkpoints");
    this.repository = options.repository;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  }

  checkpoint(
    effects: readonly EvaluatedEffect[],
    options: { toolCallId?: string; sessionId?: string; baseline?: ExecutionBaseline } = {},
  ): RecoveryCheckpoint {
    const paths = [...new Set(
      effects
        .map((effect) => effect.path ?? effect.entryPath ?? effect.resolvedPath)
        .filter((path): path is string => path !== undefined),
    )].map((path) => resolveAccessEntryPath(path, "write", this.root)).sort();
    if (paths.length === 0) throw new Error("No concrete path was available for recovery checkpointing.");

    const id = newId("checkpoint");
    const directory = join(this.directory, id);
    try {
      mkdirSync(join(directory, "files"), { recursive: true, mode: 0o700 });
      const entries: SnapshotEntry[] = [];
      const bytes = { value: 0 };
      for (const path of paths) this.capturePath(path, directory, entries, bytes);

      const repositoryState = this.repository.captureRecoveryState?.(paths) ?? {
        provider: this.repository.name,
      };
      const createdAt = new Date().toISOString();
      const restoreCommand = `atlr recovery restore ${id}`;
      const manifest: RecoveryManifest = {
        version: 1,
        id,
        createdAt,
        workspaceRoot: this.root,
        paths,
        entries,
        repositoryState,
        ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
        ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        restoreCommand,
      };
      writeFileSync(
        join(directory, "checkpoint.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      this.verifyCheckpoint(directory, manifest);
      return this.checkpointRecord(directory, manifest);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  get(id: string): RecoveryCheckpoint {
    const directory = join(this.directory, basename(id));
    return this.checkpointRecord(directory, this.readManifest(directory));
  }

  list(): RecoveryCheckpoint[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = join(this.directory, entry.name);
        try {
          return [this.checkpointRecord(directory, this.readManifest(directory))];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  restore(id: string): string[] {
    const directory = join(this.directory, basename(id));
    const manifest = this.readManifest(directory);
    if (!sameAccessPath(manifest.workspaceRoot, this.root, "write")) {
      throw new Error("Recovery checkpoint belongs to a different Atelier workspace.");
    }

    // Validate the complete manifest before creating the quarantine directory,
    // then repeat the validation immediately before each filesystem mutation.
    // The second check closes the common symlink-parent replacement window.
    for (const path of [...manifest.paths, ...manifest.entries.map((entry) => entry.path)]) {
      this.validateRestorePath(path);
    }

    const quarantine = mkdtempSync(join(this.root, ".atlr-restore-"));
    try {
      let quarantineEntry = 0;
      for (const path of [...manifest.paths].sort((left, right) => right.length - left.length)) {
        const target = this.validateRestorePath(path);
        if (lexicalStat(target) === undefined) continue;
        // renameSync atomically detaches the named entry and does not follow a
        // final symlink. Keep the quarantine on the workspace filesystem so
        // the operation cannot degrade into a copy-and-delete.
        renameSync(target, join(quarantine, String(quarantineEntry)));
        quarantineEntry += 1;
      }
      for (const entry of [...manifest.entries].sort((left, right) => left.path.length - right.path.length)) {
        this.restoreEntry(entry, directory);
      }
      this.removeRestoreQuarantine(quarantine);

      // Git restores the exact index after copied worktree contents. Jujutsu
      // restores the captured operation, which becomes authoritative for tracked
      // paths while copied ignored/untracked paths remain intact.
      this.repository.restoreRecoveryState?.(manifest.repositoryState, manifest.paths);
      this.verifyRestored(manifest);
      this.repository.verifyRecoveryState?.(manifest.repositoryState, manifest.paths);
      return manifest.paths;
    } finally {
      this.removeRestoreQuarantine(quarantine);
    }
  }

  private checkpointRecord(directory: string, manifest: RecoveryManifest): RecoveryCheckpoint {
    return {
      id: manifest.id,
      directory,
      createdAt: manifest.createdAt,
      paths: manifest.paths,
      repositoryState: manifest.repositoryState,
      ...(manifest.baseline === undefined ? {} : { baseline: manifest.baseline }),
      ...(manifest.toolCallId === undefined ? {} : { toolCallId: manifest.toolCallId }),
      ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId }),
      restoreCommand: manifest.restoreCommand,
    };
  }

  private capturePath(
    path: string,
    directory: string,
    entries: SnapshotEntry[],
    bytes: { value: number },
  ): void {
    const targetPath = repositoryPathTarget(this.root, path, "write");
    const absolute = targetPath.entry;
    const rel = targetPath.relative;
    if (rel === ".") throw new Error(`Checkpoint path cannot be the entire workspace root: ${absolute}`);

    const stat = lexicalStat(absolute);
    if (stat === undefined) {
      entries.push({ path: absolute, kind: "missing" });
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({
        path: absolute,
        kind: "symlink",
        mode: Number(stat.mode),
        target: readlinkSync(absolute),
      });
      return;
    }
    if (stat.isDirectory()) {
      const unsuitable = rel
        .split("/")
        .find((segment) => UNSUITABLE_CHECKPOINT_DIRECTORIES.has(segment));
      if (unsuitable !== undefined) {
        throw new Error(
          `Automatic checkpointing is unsuitable for directory ${absolute} (${unsuitable}).`,
        );
      }
      entries.push({ path: absolute, kind: "directory", mode: Number(stat.mode) });
      for (const child of readdirSync(absolute)) {
        this.capturePath(join(absolute, child), directory, entries, bytes);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Checkpointing special files is not supported: ${absolute}`);
    }

    const fileBytes = Number(stat.size);
    bytes.value += fileBytes;
    if (bytes.value > this.maxBytes) {
      throw new Error(`Recovery checkpoint exceeds ${this.maxBytes} bytes.`);
    }
    const target = join(directory, "files", rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(absolute, target);
    chmodSync(target, Number(stat.mode) & 0o7777);
    entries.push({
      path: absolute,
      kind: "file",
      mode: Number(stat.mode),
      digest: digest(absolute),
      bytes: fileBytes,
    });
  }

  private restoreEntry(entry: SnapshotEntry, directory: string): void {
    const path = this.validateRestorePath(entry.path);
    if (entry.kind === "missing") return;
    this.ensureRestoreParent(path);

    if (entry.kind === "directory") {
      this.validateRestorePath(path);
      if (lexicalStat(path) !== undefined) {
        throw new Error(`Recovery restore expected ${path} to be absent before directory creation.`);
      }
      mkdirSync(path, { mode: 0o700 });
      if (entry.mode !== undefined) this.chmodRestoreEntry(path, entry.mode, true);
      return;
    }

    if (entry.kind === "symlink") {
      this.validateRestorePath(path);
      if (lexicalStat(path) !== undefined) {
        throw new Error(`Recovery restore expected ${path} to be absent before symlink creation.`);
      }
      symlinkSync(entry.target ?? "", path);
      return;
    }

    const rel = repositoryRelativePath(this.root, path, "write");
    const stored = join(directory, "files", rel);
    const temporary = join(dirname(path), `.atlr-restore-${newId("file")}`);
    let temporaryPath: string | undefined = temporary;
    try {
      this.validateRestorePath(temporary);
      copyFileSync(stored, temporary, constants.COPYFILE_EXCL);
      this.validateRestorePath(path);
      if (lexicalStat(path) !== undefined) {
        throw new Error(`Recovery restore expected ${path} to be absent before file creation.`);
      }
      // A same-directory rename makes the destination replacement atomic and
      // never follows a final symlink at the destination.
      renameSync(temporary, path);
      temporaryPath = undefined;
    } finally {
      if (temporaryPath !== undefined) this.removeRestoreTemporary(temporaryPath);
    }
    if (entry.mode !== undefined) this.chmodRestoreEntry(path, entry.mode, false);
  }

  private validateRestorePath(path: string): string {
    const target = repositoryPathTarget(this.root, path, "write");
    if (target.entry === this.root) {
      throw new Error(`Recovery restore cannot mutate the workspace root: ${path}`);
    }
    return target.entry;
  }

  private ensureRestoreParent(path: string): void {
    const parent = dirname(path);
    const relative = repositoryRelativePath(this.root, parent, "write");
    if (relative === ".") return;

    let current = this.root;
    for (const segment of relative.split("/")) {
      current = join(current, segment);
      const target = this.validateRestorePath(current);
      const stat = lexicalStat(target);
      if (stat === undefined) {
        mkdirSync(target, { mode: 0o700 });
      } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Recovery restore requires a non-symlink directory at ${target}.`);
      }
    }
  }

  private removeRestoreTemporary(path: string): void {
    try {
      const target = this.validateRestorePath(path);
      if (lexicalStat(target) !== undefined) unlinkSync(target);
    } catch {
      // An uncertain path is deliberately left untouched rather than risking
      // cleanup through a replaced parent directory.
    }
  }

  private removeRestoreQuarantine(path: string): void {
    const target = this.validateRestorePath(path);
    if (lexicalStat(target) !== undefined) rmSync(target, { force: true, recursive: true });
  }

  private chmodRestoreEntry(path: string, mode: number, directory: boolean): void {
    const target = this.validateRestorePath(path);
    const noFollow = constants.O_NOFOLLOW;
    if (noFollow === undefined) {
      const stat = lexicalStat(target);
      if (stat === undefined || stat.isSymbolicLink()) {
        throw new Error(`Recovery restore cannot safely apply the mode at ${target}.`);
      }
      chmodSync(target, mode & 0o7777);
      return;
    }

    const flags = constants.O_RDONLY
      | noFollow
      | (directory ? (constants.O_DIRECTORY ?? 0) : 0);
    const fd = openSync(target, flags);
    try {
      const stat = fstatSync(fd);
      if (directory ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`Recovery restore found the wrong entry type at ${target}.`);
      }
      fchmodSync(fd, mode & 0o7777);
    } finally {
      closeSync(fd);
    }
  }

  private verifyCheckpoint(directory: string, manifest: RecoveryManifest): void {
    if (manifest.baseline !== undefined && manifest.baseline.digest !== executionBaselineDigest(manifest.baseline)) {
      throw new Error("Recovery checkpoint execution baseline verification failed.");
    }
    for (const entry of manifest.entries) {
      if (entry.kind === "file") {
        const rel = repositoryRelativePath(this.root, entry.path, "write");
        const stored = join(directory, "files", rel);
        if (!existsSync(stored) || digest(stored) !== entry.digest) {
          throw new Error(`Recovery checkpoint verification failed for ${entry.path}.`);
        }
      }
      if (entry.kind === "symlink" && entry.target === undefined) {
        throw new Error(`Recovery checkpoint is missing the symlink target for ${entry.path}.`);
      }
    }
    this.repository.verifyRecoveryState?.(manifest.repositoryState, manifest.paths);
  }

  private verifyRestored(manifest: RecoveryManifest): void {
    for (const entry of manifest.entries) {
      const stat = lexicalStat(entry.path);
      if (entry.kind === "missing") {
        if (stat !== undefined) {
          throw new Error(`Recovery restore expected ${entry.path} to remain missing.`);
        }
        continue;
      }
      if (stat === undefined) {
        throw new Error(`Recovery restore did not recreate ${entry.path}.`);
      }
      if (entry.kind === "directory") {
        if (!stat.isDirectory()) {
          throw new Error(`Recovery restore expected a directory at ${entry.path}.`);
        }
      } else if (entry.kind === "symlink") {
        if (!stat.isSymbolicLink() || readlinkSync(entry.path) !== entry.target) {
          throw new Error(`Recovery restore did not recreate the exact symlink at ${entry.path}.`);
        }
      } else if (!stat.isFile() || digest(entry.path) !== entry.digest) {
        throw new Error(`Recovery restore did not recreate the exact file at ${entry.path}.`);
      }
      if (entry.mode !== undefined && (Number(stat.mode) & 0o7777) !== (entry.mode & 0o7777)) {
        throw new Error(`Recovery restore did not preserve the mode for ${entry.path}.`);
      }
    }
  }

  private readManifest(directory: string): RecoveryManifest {
    const path = join(directory, "checkpoint.json");
    if (!existsSync(path)) throw new Error(`Recovery checkpoint not found: ${path}`);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as RecoveryManifest;
    if (manifest.version !== 1) {
      throw new Error(`Unsupported recovery checkpoint version: ${String(manifest.version)}`);
    }
    if (manifest.baseline !== undefined && manifest.baseline.digest !== executionBaselineDigest(manifest.baseline)) {
      throw new Error("Recovery checkpoint execution baseline verification failed.");
    }
    return manifest;
  }
}
