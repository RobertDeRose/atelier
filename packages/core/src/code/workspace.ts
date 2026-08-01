import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { ConfigurationError } from "../domain/errors.ts";
import type { RepositorySnapshot } from "../repository/snapshot.ts";
import { resolveAccessPath } from "../security/path-boundary.ts";
import type { CodeWorkspace } from "./types.ts";

interface WorkspaceFile {
  name?: string;
  repositories?: Array<{
    id?: string;
    name?: string;
    path: string;
    role?: string;
    tags?: string[];
    codesearchProject?: string;
  }>;
}

export interface CodeWorkspaceLoadOptions {
  workspacePath?: string;
  snapshotForRoot?: (root: string) => RepositorySnapshot;
  rootWithinWorkspace?: (root: string) => boolean;
}

function canonicalRoot(path: string): string {
  return resolveAccessPath(path, "read");
}

export function loadCodeWorkspace(
  root: string,
  primary: RepositorySnapshot,
  snapshotForRootOrOptions?: ((root: string) => RepositorySnapshot) | CodeWorkspaceLoadOptions,
): CodeWorkspace {
  const projectRoot = canonicalRoot(root);
  const options: CodeWorkspaceLoadOptions = typeof snapshotForRootOrOptions === "function"
    ? { snapshotForRoot: snapshotForRootOrOptions }
    : (snapshotForRootOrOptions ?? {});
  const workspacePath = resolveAccessPath(
    options.workspacePath ?? resolve(projectRoot, ".atelier", "workspace.json"),
    "read",
    projectRoot,
  );
  if (!existsSync(workspacePath)) return singleWorkspace(projectRoot, primary);
  const parsed = JSON.parse(readFileSync(workspacePath, "utf8")) as WorkspaceFile;
  if (parsed === null || typeof parsed !== "object" || (parsed.repositories !== undefined && !Array.isArray(parsed.repositories))) {
    throw new ConfigurationError(`Invalid code workspace configuration: ${workspacePath}`);
  }

  const repositories = (parsed.repositories ?? []).map((entry, index) => {
    if (!entry.path || typeof entry.path !== "string") {
      throw new ConfigurationError(`workspace repository ${index + 1} is missing path`);
    }
    const unresolved = isAbsolute(entry.path) ? resolve(entry.path) : resolve(projectRoot, entry.path);
    const repositoryRoot = canonicalRoot(unresolved);
    if (options.rootWithinWorkspace !== undefined && !options.rootWithinWorkspace(repositoryRoot)) {
      throw new ConfigurationError(
        `Workspace repository is outside the immutable session workspace: ${repositoryRoot}. `
        + `Start Atelier from a common parent workspace or use --workspace.`,
      );
    }
    const snapshot = repositoryRoot === projectRoot
      ? primary
      : options.snapshotForRoot?.(repositoryRoot);
    if (snapshot === undefined) {
      throw new ConfigurationError(`No repository snapshot provider is available for workspace root: ${repositoryRoot}`);
    }
    return {
      id: entry.id ?? snapshot.repositoryId,
      name: entry.name ?? basename(repositoryRoot),
      root: repositoryRoot,
      snapshot,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.codesearchProject ? { codesearchProject: entry.codesearchProject } : {}),
    };
  });
  if (repositories.length === 0) return singleWorkspace(projectRoot, primary);
  const ids = repositories.map((repository) => repository.id);
  if (new Set(ids).size !== ids.length) throw new ConfigurationError("workspace repository IDs must be unique");
  const roots = repositories.map((repository) => repository.root);
  if (new Set(roots).size !== roots.length) throw new ConfigurationError("workspace repository roots must be unique");
  return {
    id: parsed.name ?? primary.workspaceId,
    name: parsed.name ?? primary.workspaceId,
    roots,
    repositories,
  };
}


export interface AsyncCodeWorkspaceLoadOptions extends Omit<CodeWorkspaceLoadOptions, "snapshotForRoot"> {
  snapshotForRoot?: (root: string) => Promise<RepositorySnapshot>;
}

/** Async counterpart used by interactive paths so secondary repository discovery never blocks Pi. */
export async function loadCodeWorkspaceAsync(
  root: string,
  primary: RepositorySnapshot,
  options: AsyncCodeWorkspaceLoadOptions = {},
): Promise<CodeWorkspace> {
  const projectRoot = canonicalRoot(root);
  const workspacePath = resolveAccessPath(
    options.workspacePath ?? resolve(projectRoot, ".atelier", "workspace.json"),
    "read",
    projectRoot,
  );
  if (!existsSync(workspacePath)) return singleWorkspace(projectRoot, primary);
  const parsed = JSON.parse(readFileSync(workspacePath, "utf8")) as WorkspaceFile;
  if (parsed === null || typeof parsed !== "object" || (parsed.repositories !== undefined && !Array.isArray(parsed.repositories))) {
    throw new ConfigurationError(`Invalid code workspace configuration: ${workspacePath}`);
  }

  const repositories = await Promise.all((parsed.repositories ?? []).map(async (entry, index) => {
    if (!entry.path || typeof entry.path !== "string") {
      throw new ConfigurationError(`workspace repository ${index + 1} is missing path`);
    }
    const unresolved = isAbsolute(entry.path) ? resolve(entry.path) : resolve(projectRoot, entry.path);
    const repositoryRoot = canonicalRoot(unresolved);
    if (options.rootWithinWorkspace !== undefined && !options.rootWithinWorkspace(repositoryRoot)) {
      throw new ConfigurationError(
        `Workspace repository is outside the immutable session workspace: ${repositoryRoot}. `
        + `Start Atelier from a common parent workspace or use --workspace.`,
      );
    }
    const snapshot = repositoryRoot === projectRoot
      ? primary
      : await options.snapshotForRoot?.(repositoryRoot);
    if (snapshot === undefined) {
      throw new ConfigurationError(`No repository snapshot provider is available for workspace root: ${repositoryRoot}`);
    }
    return {
      id: entry.id ?? snapshot.repositoryId,
      name: entry.name ?? basename(repositoryRoot),
      root: repositoryRoot,
      snapshot,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.codesearchProject ? { codesearchProject: entry.codesearchProject } : {}),
    };
  }));
  if (repositories.length === 0) return singleWorkspace(projectRoot, primary);
  const ids = repositories.map((repository) => repository.id);
  if (new Set(ids).size !== ids.length) throw new ConfigurationError("workspace repository IDs must be unique");
  const roots = repositories.map((repository) => repository.root);
  if (new Set(roots).size !== roots.length) throw new ConfigurationError("workspace repository roots must be unique");
  return {
    id: parsed.name ?? primary.workspaceId,
    name: parsed.name ?? primary.workspaceId,
    roots,
    repositories,
  };
}

function singleWorkspace(root: string, snapshot: RepositorySnapshot): CodeWorkspace {
  return {
    id: snapshot.workspaceId,
    name: snapshot.workspaceId,
    roots: [root],
    repositories: [{ id: snapshot.repositoryId, name: basename(root), root, snapshot }],
  };
}

export function validateCodeWorkspace(workspace: CodeWorkspace): string[] {
  const issues: string[] = [];
  for (const repository of workspace.repositories) {
    if (!existsSync(repository.root)) issues.push(`Repository ${repository.id} path does not exist: ${repository.root}`);
    if (!repository.id.trim()) issues.push("Repository ID cannot be empty");
    if (repository.snapshot.headCommit === "unknown" || repository.snapshot.dirtyFingerprint === "unknown") {
      issues.push(`Repository ${repository.id} does not have a revision-qualified snapshot.`);
    }
  }
  return issues;
}
