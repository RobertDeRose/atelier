import { isAbsolute, relative } from "node:path";
import { RepositoryObservationError } from "../domain/errors.ts";
import {
  resolveAccessPath,
  resolveAccessTarget,
  type PathAccess,
} from "../security/path-boundary.ts";

export interface RepositoryPathTarget {
  /** Stable lookup key matching the caller's absolute spelling. */
  key: string;
  /** Canonical access target after resolving the final symlink. */
  absolute: string;
  /** Canonical parent path preserving the final filesystem entry. */
  entry: string;
  /** Repository-relative spelling of the filesystem entry for VCS pathspecs. */
  relative: string;
}

/** Canonical repository identity used for comparisons, caches, and VCS cwd. */
export function canonicalRepositoryRoot(repositoryRoot: string): string {
  return resolveAccessPath(repositoryRoot, "read");
}

/**
 * Resolve one caller path relative to the repository, canonicalize both sides,
 * and reject aliases or symlinks that escape the worktree.
 */
export function repositoryPathTarget(
  repositoryRoot: string,
  path: string,
  access: PathAccess = "write",
): RepositoryPathTarget {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const target = resolveAccessTarget(path, access, root);
  const canonicalRelationship = relative(root, target.canonical);
  if (
    canonicalRelationship !== ""
    && (canonicalRelationship.startsWith("..") || isAbsolute(canonicalRelationship))
  ) {
    throw new RepositoryObservationError(`Repository path is outside the worktree: ${target.lexical}`, {
      repositoryRoot: root,
      path: target.lexical,
      canonicalPath: target.canonical,
      entryPath: target.entry,
    });
  }

  // When the caller names the repository root through an alias, the final
  // component may itself be that alias. The canonical target is authoritative
  // for the root identity; descendants use the canonicalized parent plus their
  // original final entry so tracked symlinks keep their VCS identity.
  const entry = canonicalRelationship === "" ? root : target.entry;
  const entryRelationship = relative(root, entry);
  if (entryRelationship !== "" && (entryRelationship.startsWith("..") || isAbsolute(entryRelationship))) {
    throw new RepositoryObservationError(`Repository entry is outside the worktree: ${target.lexical}`, {
      repositoryRoot: root,
      path: target.lexical,
      canonicalPath: target.canonical,
      entryPath: entry,
    });
  }

  return {
    key: target.lexical,
    absolute: target.canonical,
    entry,
    relative: entryRelationship.replaceAll("\\", "/") || ".",
  };
}

/**
 * Convert caller paths into canonical repository-relative VCS pathspecs while
 * preserving each caller's absolute spelling as the returned map key.
 *
 * Relative inputs are resolved against the repository root, never against the
 * process working directory. Absolute aliases such as macOS /var and
 * /private/var remain valid lookup keys while sharing one canonical pathspec.
 */
export function repositoryPathTargets(
  repositoryRoot: string,
  paths: readonly string[],
  access: PathAccess = "write",
): RepositoryPathTarget[] {
  const byKey = new Map<string, RepositoryPathTarget>();
  for (const path of paths) {
    const target = repositoryPathTarget(repositoryRoot, path, access);
    if (!byKey.has(target.key)) byKey.set(target.key, target);
  }
  return [...byKey.values()];
}

/** Unique canonical VCS pathspecs for a set of caller paths. */
export function repositoryPathspecs(
  repositoryRoot: string,
  paths: readonly string[],
  access: PathAccess = "write",
): string[] {
  return [...new Set(repositoryPathTargets(repositoryRoot, paths, access).map((target) => target.relative))];
}

/** Canonical repository-relative spelling for one path. */
export function repositoryRelativePath(
  repositoryRoot: string,
  path: string,
  access: PathAccess = "write",
): string {
  return repositoryPathTarget(repositoryRoot, path, access).relative;
}
