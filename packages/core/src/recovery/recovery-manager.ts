import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { newId } from "../util/ids.ts";
import type { EvaluatedEffect } from "../policy/workspace-policy.ts";

export interface RecoveryCheckpoint {
  id: string;
  directory: string;
  createdAt: string;
  paths: string[];
  restoreCommand: string;
}

export class RecoveryManager {
  readonly root: string;
  readonly directory: string;
  readonly maxBytes: number;

  constructor(options: { workspaceRoot: string; runtimeDirectory: string; maxBytes?: number }) {
    this.root = resolve(options.workspaceRoot);
    this.directory = join(options.runtimeDirectory, "checkpoints");
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  }

  checkpoint(effects: readonly EvaluatedEffect[]): RecoveryCheckpoint {
    const paths = [...new Set(effects.map((effect) => effect.resolvedPath).filter((path): path is string => path !== undefined && existsSync(path)))];
    const id = newId("checkpoint");
    const directory = join(this.directory, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let bytes = 0;
    for (const path of paths) {
      const stat = lstatSync(path);
      bytes += stat.size;
      if (bytes > this.maxBytes) throw new Error(`Recovery checkpoint exceeds ${this.maxBytes} bytes.`);
      const rel = relative(this.root, path);
      if (!rel || rel.startsWith("..")) throw new Error(`Checkpoint path is outside workspace: ${path}`);
      const target = join(directory, "files", rel);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(path), target);
      else if (stat.isFile()) copyFileSync(path, target);
      else throw new Error(`Checkpointing directories or special files is not supported: ${path}`);
    }
    const createdAt = new Date().toISOString();
    const restoreCommand = `atlr recovery restore ${id}`;
    writeFileSync(join(directory, "checkpoint.json"), `${JSON.stringify({ id, createdAt, workspaceRoot: this.root, paths, restoreCommand }, null, 2)}\n`, { mode: 0o600 });
    return { id, directory, createdAt, paths, restoreCommand };
  }

  list(): RecoveryCheckpoint[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          const metadata = JSON.parse(readFileSync(join(this.directory, entry.name, "checkpoint.json"), "utf8")) as RecoveryCheckpoint;
          return { ...metadata, directory: join(this.directory, entry.name) };
        } catch { return undefined; }
      })
      .filter((entry): entry is RecoveryCheckpoint => entry !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  restore(id: string): string[] {
    const directory = join(this.directory, basename(id));
    const metadata = JSON.parse(String(requireRead(join(directory, "checkpoint.json")))) as { paths: string[] };
    for (const path of metadata.paths) {
      const rel = relative(this.root, path);
      const source = join(directory, "files", rel);
      mkdirSync(dirname(path), { recursive: true });
      const stat = lstatSync(source);
      if (existsSync(path)) rmSync(path, { force: true, recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), path);
      else copyFileSync(source, path);
    }
    return metadata.paths;
  }
}

function requireRead(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`Recovery checkpoint not found: ${path}`);
  return readFileSync(path);
}
