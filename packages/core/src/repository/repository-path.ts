import { isAbsolute, relative, resolve } from "node:path";
import { RepositoryObservationError } from "../domain/errors.ts";
import { resolveAccessPath, type PathAccess } from "../security/path-boundary.ts";

export interface RepositoryPathTarget {
  /** Stable lookup key matching the caller's absolute spelling. */
  key: string;
  /** Canonical path after resolving every existing ancestor. */
  absolute: string;
  /** Canonical repository-relative path suitable for VCS pathspecs. */
  relative: string;
}

/**
 * Convert caller paths into canonical repository-relative VCS pathspecs while
 * preserving the caller's absolute spelling as the returned map key.
 *
 * macOS exposes temporary paths through both /var and /private/var. Computing
 * relative paths before canonicalizing both sides turns an in-repository path
 * into ../../../../var/..., which Git correctly rejects as outside the worktree.
 */
export function repositoryPathTargets(
  repositoryRoot: string,
  paths: readonly string[],
  access: PathAccess = "write",
): RepositoryPathTarget[] {
  const root = resolveAccessPath(repositoryRoot, "read");
  const seen = new Set<string>();
  const targets: RepositoryPathTarget[] = [];

  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);

    const absolute = resolveAccessPath(key, access);
    const relationship = relative(root, absolute);
    if (relationship !== "" && (relationship.startsWith("..") || isAbsolute(relationship))) {
      throw new RepositoryObservationError(`Repository path is outside the worktree: ${key}`, {
        repositoryRoot: root,
        path: key,
        canonicalPath: absolute,
      });
    }

    targets.push({
      key,
      absolute,
      relative: relationship.replaceAll("\\", "/") || ".",
    });
  }

  return targets;
}
