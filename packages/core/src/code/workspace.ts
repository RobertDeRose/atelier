import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { RepositorySnapshot } from "../domain/types.ts";
import type { CodeWorkspace } from "./types.ts";

interface WorkspaceFile {
  name?: string;
  repositories?: Array<{ id?: string; name?: string; path: string; role?: string; tags?: string[]; codesearchProject?: string }>;
}

export function loadCodeWorkspace(root: string, primary: RepositorySnapshot, snapshotForRoot?: (root: string) => RepositorySnapshot): CodeWorkspace {
  const path = resolve(root, ".atelier", "workspace.json");
  if (!existsSync(path)) return singleWorkspace(root, primary);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkspaceFile;
  const repositories = (parsed.repositories ?? []).map((entry, index) => {
    if (!entry.path) throw new Error(`workspace repository ${index + 1} is missing path`);
    const repositoryRoot = isAbsolute(entry.path) ? resolve(entry.path) : resolve(root, entry.path);
    const snapshot = repositoryRoot === root ? primary : snapshotForRoot?.(repositoryRoot) ?? {
      repositoryId: entry.id ?? basename(repositoryRoot), workspaceId: entry.id ?? basename(repositoryRoot), vcs: "none" as const, headCommit: "unknown", dirtyGeneration: 0, dirtyFingerprint: "unknown", indexSchemaVersion: primary.indexSchemaVersion,
    };
    return { id: entry.id ?? snapshot.repositoryId, name: entry.name ?? basename(repositoryRoot), root: repositoryRoot, snapshot, ...(entry.role ? { role: entry.role } : {}), ...(entry.tags ? { tags: entry.tags } : {}), ...(entry.codesearchProject ? { codesearchProject: entry.codesearchProject } : {}) };
  });
  if (repositories.length === 0) return singleWorkspace(root, primary);
  const ids = repositories.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("workspace repository IDs must be unique");
  const roots = repositories.map((r) => r.root);
  if (new Set(roots).size !== roots.length) throw new Error("workspace repository roots must be unique");
  return { id: parsed.name ?? primary.workspaceId, name: parsed.name ?? primary.workspaceId, roots, repositories };
}

function singleWorkspace(root: string, snapshot: RepositorySnapshot): CodeWorkspace {
  return { id: snapshot.workspaceId, name: snapshot.workspaceId, roots: [root], repositories: [{ id: snapshot.repositoryId, name: basename(root), root, snapshot }] };
}

export function validateCodeWorkspace(workspace: CodeWorkspace): string[] {
  const issues: string[] = [];
  for (const repo of workspace.repositories) {
    if (!existsSync(repo.root)) issues.push(`Repository ${repo.id} path does not exist: ${repo.root}`);
    if (!repo.id.trim()) issues.push("Repository ID cannot be empty");
  }
  return issues;
}
