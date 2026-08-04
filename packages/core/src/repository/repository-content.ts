import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "../util/hash.ts";
import { repositoryPathTarget } from "./repository-path.ts";

/** Hard ceiling for repository content included in observation fingerprints. */
export const MAX_REPOSITORY_HASH_BYTES = 16 * 1024 * 1024;

export interface RepositoryContentObservation {
  value: string;
  files: number;
  bytes: number;
}

export function repositoryContentFingerprint(root: string, paths: readonly string[], hashContents: boolean): string {
  return [...new Set(paths)].sort().map((path) => repositoryContentState(root, path, hashContents).value).join("\\0");
}

export function hashRepositoryContents(root: string, paths: readonly string[]): { value: string; files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const value = [...new Set(paths)].sort().map((path) => {
    const result = repositoryContentState(root, path, true);
    files += result.files;
    bytes += result.bytes;
    return result.value;
  }).join("\\0");
  return { value, files, bytes };
}

/**
 * Fingerprint one worktree path without following a final symlink or reading
 * an external, broken, or oversized target.
 */
export function repositoryContentState(
  repositoryRoot: string,
  path: string,
  hashContents: boolean,
): RepositoryContentObservation {
  const lexical = resolve(repositoryRoot, path);
  let target;
  try {
    target = repositoryPathTarget(repositoryRoot, path, "read");
  } catch {
    const metadata = lstatSync(lexical, { throwIfNoEntry: false });
    return metadata?.isSymbolicLink()
      ? symlinkState(repositoryRoot, path, lexical)
      : { value: `${path}:outside`, files: 0, bytes: 0 };
  }

  const metadata = lstatSync(target.entry, { throwIfNoEntry: false });
  if (metadata === undefined) return { value: `${path}:deleted`, files: 0, bytes: 0 };
  if (metadata.isSymbolicLink()) return symlinkState(repositoryRoot, path, target.entry);
  if (!metadata.isFile()) {
    return { value: `${path}:non-file:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}`, files: 0, bytes: 0 };
  }
  if (metadata.size > MAX_REPOSITORY_HASH_BYTES) {
    return { value: `${path}:oversized:${metadata.size}`, files: 0, bytes: 0 };
  }
  if (!hashContents) {
    return { value: `${path}:${metadata.size}:${metadata.mtimeMs}`, files: 0, bytes: 0 };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(target.entry, "r");
    const buffer = Buffer.allocUnsafe(MAX_REPOSITORY_HASH_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_REPOSITORY_HASH_BYTES) {
      return { value: `${path}:oversized:${bytesRead}+`, files: 0, bytes: 0 };
    }
    const content = buffer.subarray(0, bytesRead);
    return {
      value: `${path}:${metadata.mode}:${content.byteLength}:${sha256(content)}`,
      files: 1,
      bytes: content.byteLength,
    };
  } catch {
    return { value: `${path}:unreadable`, files: 0, bytes: 0 };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function symlinkState(repositoryRoot: string, path: string, entry: string): RepositoryContentObservation {
  let linkTarget: string;
  try {
    linkTarget = readlinkSync(entry);
  } catch {
    return { value: `${path}:symlink:unreadable`, files: 0, bytes: 0 };
  }

  let withinRepository = false;
  try {
    repositoryPathTarget(repositoryRoot, path, "read");
    withinRepository = true;
  } catch {
    // The target is deliberately not inspected after a boundary failure.
  }
  if (!withinRepository) return { value: `${path}:symlink:outside:${linkTarget}`, files: 0, bytes: 0 };

  const target = resolve(dirname(entry), linkTarget);
  const targetMetadata = lstatSync(target, { throwIfNoEntry: false });
  return {
    value: `${path}:symlink:${targetMetadata === undefined ? "broken" : "internal"}:${linkTarget}`,
    files: 0,
    bytes: 0,
  };
}
