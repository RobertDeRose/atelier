/**
 * Legacy compatibility shim. Atelier no longer persists or requires project
 * trust. Old trust stores are ignored and these functions do not grant
 * filesystem authority.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonical(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function projectTrustStatus(projectRoot: string) {
  const root = canonical(projectRoot);
  return { trusted: true, root, storePath: "disabled", record: { root, trustedAt: "session", workspaceRoots: [root] } };
}
export function isProjectTrusted(_projectRoot: string): boolean { return true; }
export function trustProject(projectRoot: string) { return projectTrustStatus(projectRoot); }
export function revokeProjectTrust(projectRoot: string) { return projectTrustStatus(projectRoot); }
export function approveWorkspaceRoot(projectRoot: string, workspaceRoot: string) { return { ...projectTrustStatus(projectRoot), workspaceRoot: canonical(workspaceRoot) }; }
export function revokeWorkspaceRoot(projectRoot: string, workspaceRoot: string) { return { ...projectTrustStatus(projectRoot), workspaceRoot: canonical(workspaceRoot) }; }
export function isWorkspaceRootApproved(projectRoot: string, workspaceRoot: string): boolean { return canonical(workspaceRoot).startsWith(canonical(projectRoot)); }
