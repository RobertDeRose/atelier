import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export type PathAccess = "read" | "write";

function canonicalExisting(path: string): string {
  return realpathSync.native(path);
}

/**
 * Resolve an access target through every existing ancestor. This catches a
 * non-existent file below a symlinked directory as well as an existing
 * symlink whose target leaves the approved root.
 */
export function resolveAccessPath(path: string, access: PathAccess = "read", base = process.cwd()): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (existsSync(absolute)) return canonicalExisting(absolute);
  if (access === "read") throw new Error(`Read target does not exist: ${absolute}`);

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

export function isPathWithin(path: string, allowedRoot: string, access: PathAccess = "read", base = process.cwd()): boolean {
  try {
    const candidate = resolveAccessPath(path, access, base);
    const allowed = resolveAccessPath(allowedRoot, "read", base);
    const relationship = relative(allowed, candidate);
    return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
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
