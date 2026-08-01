import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export type PathAccess = "read" | "write";

export interface AccessPathTarget {
  /** Absolute lexical spelling resolved against the supplied base. */
  lexical: string;
  /** Canonical parent spelling while preserving the final filesystem entry. */
  entry: string;
  /** Canonical spelling after resolving every existing ancestor and final symlink. */
  canonical: string;
}

function canonicalExisting(path: string): string {
  return realpathSync.native(path);
}

/** Resolve a path lexically without consulting the filesystem. */
export function resolveAbsolutePath(path: string, base = process.cwd()): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

/**
 * Resolve an access target through every existing ancestor. This catches a
 * non-existent file below a symlinked directory as well as an existing
 * symlink whose target leaves the approved root.
 *
 * The explicit base is important for repository-relative paths: resolving
 * against process.cwd() can silently reinterpret a VCS path when the provider
 * was opened through another working directory or filesystem alias.
 */
export function resolveAccessPath(path: string, access: PathAccess = "read", base = process.cwd()): string {
  void access;
  const absolute = resolveAbsolutePath(path, base);
  if (existsSync(absolute)) return canonicalExisting(absolute);
  const missing: string[] = [];
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Unable to resolve an existing ancestor for ${absolute}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(canonicalExisting(ancestor), ...missing);
}

/**
 * Resolve the filesystem entry named by a path while preserving the final
 * component itself. Parent-directory aliases are canonicalized, but a final
 * symlink remains the symlink entry rather than becoming its target.
 *
 * This distinction is required for VCS pathspecs and recovery snapshots: Git
 * tracks the link named `tracked-link`, not the file to which it currently
 * points. Missing descendants are reconstructed below the nearest existing
 * canonical ancestor in the same way as resolveAccessPath().
 */
export function resolveAccessEntryPath(
  path: string,
  access: PathAccess = "read",
  base = process.cwd(),
): string {
  void access;
  const absolute = resolveAbsolutePath(path, base);
  const parent = dirname(absolute);
  if (parent === absolute) return resolveAccessPath(absolute, access, base);

  const missing: string[] = [basename(absolute)];
  let ancestor = parent;
  while (!existsSync(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error(`Unable to resolve an existing ancestor for ${absolute}`);
    missing.unshift(basename(ancestor));
    ancestor = next;
  }
  return resolve(canonicalExisting(ancestor), ...missing);
}

/** Return both the caller-facing lexical key and the canonical comparison path. */
export function resolveAccessTarget(
  path: string,
  access: PathAccess = "read",
  base = process.cwd(),
): AccessPathTarget {
  const lexical = resolveAbsolutePath(path, base);
  return {
    lexical,
    entry: resolveAccessEntryPath(lexical, access),
    canonical: resolveAccessPath(lexical, access),
  };
}

/**
 * Return a canonical relative path when the target remains inside the root.
 * Undefined means the target escapes the root after resolving aliases and
 * existing symlink ancestors.
 */
export function relativeAccessPath(
  path: string,
  allowedRoot: string,
  access: PathAccess = "read",
  base = allowedRoot,
): string | undefined {
  try {
    const candidate = resolveAccessPath(path, access, base);
    const allowed = resolveAccessPath(allowedRoot, "read", base);
    const relationship = relative(allowed, candidate);
    return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))
      ? relationship.replaceAll("\\", "/")
      : undefined;
  } catch {
    return undefined;
  }
}

export function isPathWithin(path: string, allowedRoot: string, access: PathAccess = "read", base = process.cwd()): boolean {
  return relativeAccessPath(path, allowedRoot, access, base) !== undefined;
}

/** Compare the named filesystem entries without conflating a final symlink with its target. */
export function sameAccessEntryPath(
  left: string,
  right: string,
  access: PathAccess = "read",
  base = process.cwd(),
): boolean {
  try {
    return resolveAccessEntryPath(left, access, base) === resolveAccessEntryPath(right, access, base);
  } catch {
    return false;
  }
}

/**
 * Test whether a named filesystem entry is equal to or below an approved entry.
 * A final directory symlink may establish the approved subtree, while a final
 * file symlink never aliases its target as the same approved file.
 */
export function isAccessEntryWithin(
  path: string,
  allowedRoot: string,
  access: PathAccess = "read",
  base = process.cwd(),
): boolean {
  try {
    const candidate = resolveAccessEntryPath(path, access, base);
    const allowedEntry = resolveAccessEntryPath(allowedRoot, access, base);
    if (candidate === allowedEntry) return true;

    const entryRelationship = relative(allowedEntry, candidate);
    if (entryRelationship !== "" && !entryRelationship.startsWith("..") && !isAbsolute(entryRelationship)) {
      return true;
    }

    const allowedCanonical = resolveAccessPath(allowedRoot, access, base);
    const canonicalRelationship = relative(allowedCanonical, candidate);
    return canonicalRelationship !== ""
      && !canonicalRelationship.startsWith("..")
      && !isAbsolute(canonicalRelationship);
  } catch {
    return false;
  }
}

export function sameAccessPath(left: string, right: string, access: PathAccess = "read", base = process.cwd()): boolean {
  try {
    return resolveAccessPath(left, access, base) === resolveAccessPath(right, access, base);
  } catch {
    return false;
  }
}
