import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { EvaluatedEffect } from "../policy/workspace-policy.ts";
import type { RepositoryProvider, RepositoryRecoveryState } from "../repository/repository-provider.ts";
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
    this.root = resolve(options.workspaceRoot);
    this.directory = join(options.runtimeDirectory, "checkpoints");
    this.repository = options.repository;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  }

  checkpoint(
    effects: readonly EvaluatedEffect[],
    options: { toolCallId?: string; sessionId?: string } = {},
  ): RecoveryCheckpoint {
    const paths = [...new Set(
      effects
        .map((effect) => effect.resolvedPath)
        .filter((path): path is string => path !== undefined),
    )].sort();
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
    if (resolve(manifest.workspaceRoot) !== this.root) {
      throw new Error("Recovery checkpoint belongs to a different Atelier workspace.");
    }

    for (const path of [...manifest.paths].sort((left, right) => right.length - left.length)) {
      if (lexicalExists(path)) rmSync(path, { force: true, recursive: true });
    }
    for (const entry of [...manifest.entries].sort((left, right) => left.path.length - right.path.length)) {
      this.restoreEntry(entry, directory);
    }

    // Git restores the exact index after copied worktree contents. Jujutsu
    // restores the captured operation, which becomes authoritative for tracked
    // paths while copied ignored/untracked paths remain intact.
    this.repository.restoreRecoveryState?.(manifest.repositoryState, manifest.paths);
    this.verifyRestored(manifest);
    this.repository.verifyRecoveryState?.(manifest.repositoryState, manifest.paths);
    return manifest.paths;
  }

  private checkpointRecord(directory: string, manifest: RecoveryManifest): RecoveryCheckpoint {
    return {
      id: manifest.id,
      directory,
      createdAt: manifest.createdAt,
      paths: manifest.paths,
      repositoryState: manifest.repositoryState,
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
    const absolute = resolve(path);
    const rel = relative(this.root, absolute).replaceAll("\\", "/");
    if (!rel || rel === ".." || rel.startsWith("../")) {
      throw new Error(`Checkpoint path is outside workspace: ${absolute}`);
    }

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
    if (entry.kind === "missing") return;
    if (entry.kind === "directory") {
      mkdirSync(entry.path, { recursive: true });
      if (entry.mode !== undefined) chmodSync(entry.path, entry.mode & 0o7777);
      return;
    }

    mkdirSync(dirname(entry.path), { recursive: true });
    if (entry.kind === "symlink") {
      symlinkSync(entry.target ?? "", entry.path);
      return;
    }

    const rel = relative(this.root, entry.path).replaceAll("\\", "/");
    copyFileSync(join(directory, "files", rel), entry.path);
    if (entry.mode !== undefined) chmodSync(entry.path, entry.mode & 0o7777);
  }

  private verifyCheckpoint(directory: string, manifest: RecoveryManifest): void {
    for (const entry of manifest.entries) {
      if (entry.kind === "file") {
        const rel = relative(this.root, entry.path).replaceAll("\\", "/");
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
    return manifest;
  }
}
