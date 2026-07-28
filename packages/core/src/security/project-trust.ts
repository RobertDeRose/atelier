import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigurationError } from "../domain/errors.ts";
import { sha256 } from "../util/hash.ts";

export interface TrustedProjectRecord {
  root: string;
  trustedAt: string;
  workspaceRoots: string[];
}

interface ProjectTrustStore {
  version: 1;
  projects: Record<string, TrustedProjectRecord>;
}

export interface ProjectTrustStatus {
  trusted: boolean;
  root: string;
  storePath: string;
  record?: TrustedProjectRecord;
}

function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function pathWithin(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
}

export function projectTrustStorePath(): string {
  return resolve(
    process.env.ATLR_TRUST_STORE
      ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "atelier", "trusted-projects.json"),
  );
}

function emptyStore(): ProjectTrustStore {
  return { version: 1, projects: {} };
}

function readStore(path = projectTrustStorePath()): ProjectTrustStore {
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectTrustStore>;
    if (parsed.version !== 1 || parsed.projects === null || typeof parsed.projects !== "object") {
      throw new Error("unsupported trust-store format");
    }
    return { version: 1, projects: parsed.projects as Record<string, TrustedProjectRecord> };
  } catch (error) {
    throw new ConfigurationError(`Unable to read Atelier project trust store: ${path}`, { error });
  }
}

function keyFor(root: string): string {
  return sha256(canonicalRoot(root));
}

function writeStore(store: ProjectTrustStore, path = projectTrustStorePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function assertExternalStore(projectRoot: string, storePath: string): void {
  const root = canonicalRoot(projectRoot);
  const store = resolve(storePath);
  if (pathWithin(store, root)) {
    throw new ConfigurationError(`Atelier trust records must be stored outside the project: ${store}`);
  }
}

export function projectTrustStatus(projectRoot: string): ProjectTrustStatus {
  const root = canonicalRoot(projectRoot);
  const storePath = projectTrustStorePath();
  assertExternalStore(root, storePath);
  const record = readStore(storePath).projects[keyFor(root)];
  const trusted = record?.root === root;
  return {
    trusted,
    root,
    storePath,
    ...(trusted && record !== undefined ? { record } : {}),
  };
}

export function isProjectTrusted(projectRoot: string): boolean {
  return projectTrustStatus(projectRoot).trusted;
}

export function trustProject(projectRoot: string): TrustedProjectRecord {
  const root = canonicalRoot(projectRoot);
  if (!existsSync(root)) throw new ConfigurationError(`Project root does not exist: ${root}`);
  const storePath = projectTrustStorePath();
  assertExternalStore(root, storePath);
  const store = readStore(storePath);
  const existing = store.projects[keyFor(root)];
  const record: TrustedProjectRecord = {
    root,
    trustedAt: existing?.trustedAt ?? new Date().toISOString(),
    workspaceRoots: [...new Set([root, ...(existing?.workspaceRoots ?? [])])].sort(),
  };
  store.projects[keyFor(root)] = record;
  writeStore(store, storePath);
  return record;
}

export function revokeProjectTrust(projectRoot: string): boolean {
  const root = canonicalRoot(projectRoot);
  const storePath = projectTrustStorePath();
  assertExternalStore(root, storePath);
  const store = readStore(storePath);
  const key = keyFor(root);
  if (store.projects[key] === undefined) return false;
  delete store.projects[key];
  writeStore(store, storePath);
  return true;
}

export function approveWorkspaceRoot(projectRoot: string, workspaceRoot: string): TrustedProjectRecord {
  const project = projectTrustStatus(projectRoot);
  if (!project.trusted || project.record === undefined) {
    throw new ConfigurationError(`Trust the primary project before approving workspace roots: ${project.root}`);
  }
  const approved = canonicalRoot(workspaceRoot);
  if (!existsSync(approved)) throw new ConfigurationError(`Workspace root does not exist: ${approved}`);
  const store = readStore(project.storePath);
  const record: TrustedProjectRecord = {
    ...project.record,
    workspaceRoots: [...new Set([...project.record.workspaceRoots, approved])].sort(),
  };
  store.projects[keyFor(project.root)] = record;
  writeStore(store, project.storePath);
  return record;
}

export function revokeWorkspaceRoot(projectRoot: string, workspaceRoot: string): TrustedProjectRecord {
  const project = projectTrustStatus(projectRoot);
  if (!project.trusted || project.record === undefined) {
    throw new ConfigurationError(`Project is not trusted: ${project.root}`);
  }
  const removed = canonicalRoot(workspaceRoot);
  if (removed === project.root) throw new ConfigurationError("The primary project root cannot be removed from its trust record.");
  const store = readStore(project.storePath);
  const record: TrustedProjectRecord = {
    ...project.record,
    workspaceRoots: project.record.workspaceRoots.filter((root) => root !== removed),
  };
  store.projects[keyFor(project.root)] = record;
  writeStore(store, project.storePath);
  return record;
}

export function isWorkspaceRootApproved(projectRoot: string, workspaceRoot: string): boolean {
  const status = projectTrustStatus(projectRoot);
  if (!status.trusted || status.record === undefined) return false;
  return status.record.workspaceRoots.includes(canonicalRoot(workspaceRoot));
}
