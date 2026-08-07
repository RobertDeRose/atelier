import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { RepositoryProvider } from "../repository/repository-provider.ts";
import type { RepositorySnapshot } from "../repository/snapshot.ts";
import { canonicalRepositoryRoot, repositoryPathTarget } from "../repository/repository-path.ts";
import { minimalEnvironment } from "../process/environment.ts";
import { runProcess } from "../process/async-process.ts";
import { redactText } from "../security/redaction.ts";
import { sha256 } from "../util/hash.ts";
import { newId, nowIso } from "../util/ids.ts";
import { stableJson } from "../context/context-capsule.ts";

const DISCOVERY_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const PREFERRED_TASKS = ["check", "test", "lint", "typecheck", "docs:check"] as const;
const MAX_DISCOVERED_ENTRYPOINTS = 64;
const MAX_PLANNED_PATHS = 256;

export type QualityGateKind = "hk" | "prek" | "husky" | "devenv" | "native-git-hook" | "mise" | "npm" | "no-gate";
export type QualityGateAvailability = "available" | "missing_tool" | "unsupported" | "conflicting" | "no_gate";
export type QualityGateRunStatus = "passed" | "failed" | "cancelled" | "timed_out" | "unavailable" | "mutation_detected" | "blocked";

export interface QualityGateSource {
  path: string;
  digest: string;
  bytes: number;
  truncated: boolean;
}

export interface QualityGateToolIdentity {
  name: string;
  executable?: string;
  /** Resolved from repository metadata when available; otherwise explicitly unknown. */
  version: string;
  available: boolean;
}

export interface QualityGateCoverage {
  scope: "repository" | "changed_paths" | "unknown";
  paths: string[];
}

export interface QualityGate {
  id: string;
  kind: QualityGateKind;
  sourcePaths: string[];
  configDigest: string;
  tool: QualityGateToolIdentity;
  command?: string[];
  supported: boolean;
  availability: QualityGateAvailability;
  reason?: string;
  coverage: QualityGateCoverage;
  mayMutate: boolean;
  precedence: number;
}

export interface QualityGateDiscoveryOptions {
  signal?: AbortSignal;
  maxFileBytes?: number;
}

export interface QualityGateGitPolicy {
  hooksPath?: string;
  hooksPathExternal: boolean;
  signingConfigured: boolean;
  filtersConfigured: boolean;
  digest: string;
}

export interface QualityGateProfile {
  version: 1;
  repositoryRoot: string;
  discoveredAt: string;
  gitPolicy: QualityGateGitPolicy;
  sourceFiles: QualityGateSource[];
  gates: QualityGate[];
  selectedGateId?: string;
  noGate: boolean;
  omissions: string[];
  digest: string;
}

export interface QualityGatePathCoverage {
  path: string;
  gateIds: string[];
  covered: boolean;
}

export interface QualityGatePlanGate {
  id: string;
  availability: QualityGateAvailability;
  supported: boolean;
  command?: string[];
  tool: QualityGateToolIdentity;
  coverage: QualityGateCoverage;
  reason?: string;
}

export interface QualityGatePlanInventory {
  version: 1;
  profileDigest: string;
  configDigest: string;
  selectedGateId?: string;
  gates: QualityGatePlanGate[];
  plannedPaths: string[];
  coverage: QualityGatePathCoverage[];
  truncated: boolean;
  missingPaths: string[];
  proposals: string[];
  digest: string;
}

export interface QualityGateRunOptions {
  /** Use an already verified profile so execution is bound to one discovery snapshot. */
  profile?: QualityGateProfile;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  changedPaths?: readonly string[];
}

export interface QualityGateProvider {
  discover(options?: QualityGateDiscoveryOptions): Promise<QualityGateProfile>;
  run(gateId: string, options?: QualityGateRunOptions): Promise<QualityGateRunResult>;
}

export type QualityGateEvidenceStatus = QualityGateRunStatus | "no_gate" | "stale";
export type QualityGateEvidenceOperation = "commit" | "closure";

export interface QualityGateBypassAuthorization {
  version: 1;
  id: string;
  taskId: string;
  executionGrantId: string;
  operation: "commit";
  gateId: string;
  profileDigest: string;
  planDigest: string;
  sourceFingerprint: string;
  reason: string;
  actor: "user";
  authorizedAt: string;
  expiresAfter: "next-commit-attempt";
}

export interface QualityGateEvidence {
  version: 1;
  id: string;
  taskId: string;
  executionGrantId: string;
  operation: QualityGateEvidenceOperation;
  gateId?: string;
  status: QualityGateEvidenceStatus;
  passed: boolean;
  profileDigest: string;
  configDigest: string;
  planDigest?: string;
  tool: QualityGateToolIdentity;
  command?: string[];
  coverage: QualityGateCoverage;
  runId?: string;
  snapshotBefore: RepositorySnapshot;
  snapshotAfter: RepositorySnapshot;
  sourceFingerprintBefore: string;
  sourceFingerprintAfter: string;
  stagedDiffHashBefore: string;
  stagedDiffHashAfter: string;
  mutationDetected: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reason?: string;
}

export class QualityGatePolicyError extends Error {
  readonly evidence: QualityGateEvidence;

  constructor(message: string, evidence: QualityGateEvidence, cause?: unknown) {
    super(message, { cause });
    this.name = "QualityGatePolicyError";
    this.evidence = evidence;
  }
}

export interface QualityGateRunResult {
  version: 1;
  id: string;
  gateId: string;
  profileDigest: string;
  status: QualityGateRunStatus;
  passed: boolean;
  command?: string[];
  cwd: string;
  tool: QualityGateToolIdentity;
  configDigest: string;
  coverage: QualityGateCoverage;
  mayMutate: boolean;
  snapshotBefore?: RepositorySnapshot;
  snapshotAfter?: RepositorySnapshot;
  changedPathsBefore: string[];
  changedPathsAfter: string[];
  mutationDetected: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reason?: string;
}

interface ReadSource {
  path: string;
  content: string;
  source: QualityGateSource;
}

interface GitMetadata {
  commonDirectory: string;
  configurations: ReadSource[];
}

function configuredGitFiles(environment: NodeJS.ProcessEnv): string[] {
  if (environment.GIT_CONFIG_GLOBAL === "/dev/null") return [];
  if (environment.GIT_CONFIG_GLOBAL !== undefined && environment.GIT_CONFIG_GLOBAL !== "") return [environment.GIT_CONFIG_GLOBAL];
  return [join(homedir(), ".gitconfig"), join(homedir(), ".config", "git", "config")];
}

function systemGitFiles(environment: NodeJS.ProcessEnv): string[] {
  if (environment.GIT_CONFIG_NOSYSTEM === "1") return [];
  return environment.GIT_CONFIG_SYSTEM === "/dev/null"
    ? []
    : [environment.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig"];
}

function sourceDigest(sources: readonly QualityGateSource[]): string {
  return sha256(stableJson(sources.map((source) => ({ ...source }))));
}

function findTool(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = isAbsolute(name)
    ? [name]
    : (environment.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return resolve(candidate);
    } catch {
      // Discovery must not execute a candidate merely to identify it.
    }
  }
  return undefined;
}

function tool(name: string, version?: string, environment: NodeJS.ProcessEnv = process.env): QualityGateToolIdentity {
  const executable = findTool(name, environment);
  return { name, ...(executable === undefined ? {} : { executable }), version: version ?? "unknown", available: executable !== undefined };
}

function configuredVersion(content: string | undefined, name: string): string | undefined {
  if (content === undefined) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`^\\s*["']?${escaped}["']?\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

function boundedRead(path: string, maximumBytes = DISCOVERY_MAX_FILE_BYTES): ReadSource | undefined {
  const limit = Number.isSafeInteger(maximumBytes) ? Math.min(Math.max(1, maximumBytes), DISCOVERY_MAX_FILE_BYTES) : DISCOVERY_MAX_FILE_BYTES;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return undefined;
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, Math.min(bytes, limit));
    return { path, content: content.toString("utf8"), source: { path, digest: sha256(content), bytes: content.byteLength, truncated: bytes > limit } };
  } finally {
    closeSync(descriptor);
  }
}

function safeBoundedRead(path: string, maximumBytes = DISCOVERY_MAX_FILE_BYTES): ReadSource | undefined {
  try {
    return boundedRead(path, maximumBytes);
  } catch {
    return undefined;
  }
}

function configDigest(sources: readonly QualityGateSource[]): string {
  return sourceDigest(sources);
}

function makeGate(input: Omit<QualityGate, "configDigest"> & { sources: readonly QualityGateSource[] }): QualityGate {
  return {
    ...input,
    sourcePaths: [...new Set(input.sourcePaths.map((path) => redactText(path)))].sort(),
    configDigest: configDigest(input.sources),
    coverage: { scope: input.coverage.scope, paths: [...new Set(input.coverage.paths)].sort() },
    ...(input.command === undefined ? {} : { command: [...input.command] }),
  };
}

function taskRank(name: string): number {
  const rank = PREFERRED_TASKS.indexOf(name as (typeof PREFERRED_TASKS)[number]);
  return rank < 0 ? PREFERRED_TASKS.length : rank;
}

function safeEntrypointName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(name);
}

function taskNames(content: string, omissions: string[]): string[] {
  const names = [...content.matchAll(/^\s*\[tasks\.([^\]]+)\]\s*$/gm)]
    .map((match) => match[1] ?? "")
    .filter(safeEntrypointName)
    .sort((a, b) => taskRank(a) - taskRank(b) || a.localeCompare(b));
  if (names.length > MAX_DISCOVERED_ENTRYPOINTS) omissions.push("mise task inventory was truncated.");
  return names.slice(0, MAX_DISCOVERED_ENTRYPOINTS);
}

function scriptNames(content: string | undefined, omissions: string[]): string[] {
  if (content === undefined) return [];
  try {
    const scripts = (JSON.parse(content) as { scripts?: unknown }).scripts;
    if (scripts === undefined || scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return [];
    const names = Object.keys(scripts as Record<string, unknown>)
      .filter(safeEntrypointName)
      .sort((a, b) => taskRank(a) - taskRank(b) || a.localeCompare(b));
    if (names.length > MAX_DISCOVERED_ENTRYPOINTS) omissions.push("package script inventory was truncated.");
    return names.slice(0, MAX_DISCOVERED_ENTRYPOINTS);
  } catch (error) {
    omissions.push(`package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function gitMetadata(root: string, environment: NodeJS.ProcessEnv = process.env): GitMetadata | undefined {
  const dotGit = join(root, ".git");
  try {
    const gitDirectory = lstatSync(dotGit).isDirectory()
      ? dotGit
      : (() => {
        const pointer = boundedRead(dotGit, 8 * 1024)?.content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
        return pointer === undefined ? undefined : resolve(root, pointer);
      })();
    if (gitDirectory === undefined) return undefined;
    const commonPointer = boundedRead(join(gitDirectory, "commondir"), 8 * 1024)?.content.trim();
    const commonDirectory = commonPointer === undefined || commonPointer === "" ? gitDirectory : resolve(gitDirectory, commonPointer);
    const configurations = [
      safeBoundedRead(join(gitDirectory, "config.worktree"), 64 * 1024),
      safeBoundedRead(join(gitDirectory, "config"), 64 * 1024),
      safeBoundedRead(join(commonDirectory, "config"), 64 * 1024),
      ...configuredGitFiles(environment).map((path) => safeBoundedRead(path, 64 * 1024)),
      ...systemGitFiles(environment).map((path) => safeBoundedRead(path, 64 * 1024)),
    ].filter((value): value is ReadSource => value !== undefined);
    return { commonDirectory, configurations };
  } catch {
    return undefined;
  }
}

function gitHooksDirectory(root: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const metadata = gitMetadata(root, environment);
  if (metadata === undefined) return undefined;
  const configured = metadata.configurations.map((value) => value.content.match(/^\s*\[core\]([\s\S]*?)(?=^\s*\[|\s*$)/m)?.[1]
    ?.match(/^\s*hooksPath\s*=\s*(.+)$/m)?.[1]?.trim()).find((value) => value !== undefined);
  return configured === undefined ? join(metadata.commonDirectory, "hooks") : resolve(root, configured);
}

function gitPolicy(root: string, attributes: QualityGateSource | undefined, environment: NodeJS.ProcessEnv = process.env): QualityGateGitPolicy {
  const metadata = gitMetadata(root, environment);
  const configurations = metadata?.configurations ?? [];
  const hooksPath = gitHooksDirectory(root, environment);
  const signingConfigured = configurations.some((value) => /(?:gpgsign\s*=\s*(?:true|yes|on)|signingkey\s*=|^\s*format\s*=)/im.test(value.content));
  const filtersConfigured = attributes !== undefined || configurations.some((value) => /^\s*\[filter(?:\s|\])/im.test(value.content) || /^\s*filter\.[^=]+\s*=/im.test(value.content));
  const hooksPathExternal = hooksPath === undefined ? false : (() => {
    const relationship = relative(root, hooksPath);
    return relationship.startsWith("..") || isAbsolute(relationship);
  })();
  const identity = {
    configurations: configurations.map((value) => ({ path: value.path, source: value.source })),
    attributes,
    hooksPath,
    signingConfigured,
    filtersConfigured,
  };
  return {
    ...(hooksPath === undefined ? {} : { hooksPath: redactText(hooksPath) }),
    hooksPathExternal,
    signingConfigured,
    filtersConfigured,
    digest: sha256(stableJson(identity)),
  };
}

interface NativeHookInventory {
  directory?: string;
  names: string[];
  external: boolean;
}

function nativeHookInventory(root: string, environment: NodeJS.ProcessEnv = process.env): NativeHookInventory {
  const directory = gitHooksDirectory(root, environment);
  if (directory === undefined) return { names: [], external: false };
  const relationship = relative(root, directory);
  const external = relationship.startsWith("..") || isAbsolute(relationship);
  if (external || !existsSync(directory)) return { directory, names: [], external };
  const names = ["pre-commit", "commit-msg", "pre-push", "post-merge", "post-checkout"]
    .filter((name) => {
      try {
        return lstatSync(join(directory, name)).isFile();
      } catch {
        return false;
      }
    }).sort();
  return { directory, names, external: false };
}

function profileDigest(profile: Omit<QualityGateProfile, "digest" | "discoveredAt">): string {
  return sha256(stableJson(profile));
}

function noGateProfile(root: string, omission?: string): QualityGateProfile {
  const gate = makeGate({
    id: "no-gate", kind: "no-gate", sources: [], sourcePaths: [], tool: { name: "none", version: "none", available: false },
    supported: false, availability: "no_gate", reason: "No runnable repository quality gate was discovered.",
    coverage: { scope: "unknown", paths: [] }, mayMutate: false, precedence: Number.MAX_SAFE_INTEGER,
  });
  const base: Omit<QualityGateProfile, "digest" | "discoveredAt"> = {
    version: 1, repositoryRoot: root, gitPolicy: { hooksPathExternal: false, signingConfigured: false, filtersConfigured: false, digest: sha256("cancelled") },
    sourceFiles: [], gates: [gate], noGate: true, omissions: omission === undefined ? [] : [omission],
  };
  return { ...base, discoveredAt: nowIso(), digest: profileDigest(base) };
}

function emptyRun(gate: QualityGate, profile: QualityGateProfile, status: QualityGateRunStatus, reason: string, startedAt: string, started: number): QualityGateRunResult {
  const finishedAt = nowIso();
  return {
    version: 1, id: newId("quality-gate-run"), gateId: gate.id, profileDigest: profile.digest, status, passed: false,
    ...(gate.command === undefined ? {} : { command: [...gate.command] }), cwd: profile.repositoryRoot, tool: { ...gate.tool },
    configDigest: gate.configDigest, coverage: { ...gate.coverage, paths: [...gate.coverage.paths] }, mayMutate: gate.mayMutate,
    changedPathsBefore: [], changedPathsAfter: [], mutationDetected: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    startedAt, finishedAt, durationMs: performance.now() - started, reason,
  };
}

export class QualityGateService implements QualityGateProvider {
  private readonly root: string;
  private readonly repository: RepositoryProvider;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: { root: string; repository: RepositoryProvider; environment?: NodeJS.ProcessEnv }) {
    this.root = canonicalRepositoryRoot(options.root);
    this.repository = options.repository;
    this.environment = options.environment ?? process.env;
  }

  private readConfig(relativePath: string, sources: QualityGateSource[], omissions: string[], options: QualityGateDiscoveryOptions): ReadSource | undefined {
    if (options.signal?.aborted === true) throw new Error("Quality-gate discovery cancelled.");
    try {
      const target = repositoryPathTarget(this.root, relativePath, "read");
      const value = boundedRead(target.entry, options.maxFileBytes ?? DISCOVERY_MAX_FILE_BYTES);
      if (value === undefined) return undefined;
      const normalized = { ...value, path: target.relative, source: { ...value.source, path: target.relative } };
      sources.push(normalized.source);
      return normalized;
    } catch (error) {
      omissions.push(`Unable to inspect ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private hasPath(relativePath: string): boolean {
    try {
      return existsSync(repositoryPathTarget(this.root, relativePath, "read").entry);
    } catch {
      return false;
    }
  }

  async discover(options: QualityGateDiscoveryOptions = {}): Promise<QualityGateProfile> {
    if (options.signal?.aborted === true) throw new Error("Quality-gate discovery cancelled.");
    const sources: QualityGateSource[] = [];
    const omissions: string[] = [];
    const gates: QualityGate[] = [];
    const readConfig = (path: string): ReadSource | undefined => this.readConfig(path, sources, omissions, options);
    const checkCancelled = (): void => {
      if (options.signal?.aborted === true) throw new Error("Quality-gate discovery cancelled.");
    };
    const add = (candidate: QualityGate): void => {
      if (!gates.some((existing) => existing.id === candidate.id)) gates.push(candidate);
    };
    const mise = readConfig("mise.toml");
    const hk = readConfig("hk.pkl");
    const attributes = readConfig(".gitattributes");
    if (hk !== undefined) {
      const identity = tool("hk", configuredVersion(mise?.content, "hk"), this.environment);
      add(makeGate({
        id: "hk:check", kind: "hk", sources: [hk.source], sourcePaths: [hk.source.path], tool: identity,
        command: ["hk", "check", "-a"], supported: true, availability: identity.available ? "available" : "missing_tool",
        ...(identity.available ? {} : { reason: "The hk executable is not available on PATH." }),
        coverage: { scope: "repository", paths: [] }, mayMutate: false, precedence: 20,
      }));
    }

    checkCancelled();
    const preCommit = [".pre-commit-config.yaml", ".pre-commit-config.yml", "prek.toml"]
      .map((path) => readConfig(path)).filter((value): value is ReadSource => value !== undefined);
    if (preCommit.length > 1) {
      add(makeGate({
        id: "prek:conflict", kind: "prek", sources: preCommit.map((value) => value.source), sourcePaths: preCommit.map((value) => value.source.path),
        tool: tool("prek", undefined, this.environment), supported: false, availability: "conflicting",
        reason: "Multiple prek/pre-commit configuration files are present; choose one explicitly.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: true, precedence: 30,
      }));
    } else if (preCommit.length === 1) {
      const source = preCommit[0]!;
      const prek = tool("prek", undefined, this.environment);
      const preCommitTool = prek.available ? prek : tool("pre-commit", undefined, this.environment);
      const executable = preCommitTool.name;
      add(makeGate({
        id: `${preCommitTool.name}:all`, kind: "prek", sources: [source.source], sourcePaths: [source.source.path], tool: preCommitTool,
        ...(preCommitTool.available ? { command: [executable, "run", "--all-files"] } : {}), supported: true,
        availability: preCommitTool.available ? "available" : "missing_tool",
        ...(preCommitTool.available ? {} : { reason: "Neither prek nor pre-commit is available on PATH." }),
        coverage: { scope: "repository", paths: [] }, mayMutate: true, precedence: 30,
      }));
    }

    checkCancelled();

    const husky = this.hasPath(".husky");
    if (husky) {
      add(makeGate({
        id: "husky:native", kind: "husky", sources: [], sourcePaths: [".husky"], tool: { name: "husky", version: "unknown", available: true },
        supported: false, availability: "unsupported", reason: "Husky hooks are exercised by Git operations; direct execution is unsupported.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: true, precedence: 80,
      }));
    }

    const devenvConfigs = ["devenv.nix", "devenv.yaml", "devenv.yml"]
      .map((path) => readConfig(path)).filter((value): value is ReadSource => value !== undefined);
    if (this.hasPath(".devenv")) devenvConfigs.push({ path: ".devenv", content: "", source: { path: ".devenv", digest: sha256(".devenv"), bytes: 0, truncated: false } });
    if (devenvConfigs.length > 1) {
      add(makeGate({
        id: "devenv:conflict", kind: "devenv", sources: devenvConfigs.map((value) => value.source), sourcePaths: devenvConfigs.map((value) => value.source.path),
        tool: tool("devenv", undefined, this.environment), supported: false, availability: "conflicting", reason: "Multiple devenv configuration sources are present; choose one explicitly.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: true, precedence: 70,
      }));
    } else if (devenvConfigs.length === 1) {
      const source = devenvConfigs[0]!;
      add(makeGate({
        id: "devenv:native", kind: "devenv", sources: [source.source], sourcePaths: [source.source.path], tool: tool("devenv", undefined, this.environment),
        supported: false, availability: "unsupported", reason: "devenv configuration is detected but the repository gate adapter is unsupported.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: true, precedence: 70,
      }));
    }

    checkCancelled();
    let nativeHooks: NativeHookInventory = { names: [], external: false };
    try {
      nativeHooks = nativeHookInventory(this.root, this.environment);
    } catch (error) {
      omissions.push(`Unable to inspect native Git hooks: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (nativeHooks.names.length > 0 || nativeHooks.external) {
      const sourcePaths = nativeHooks.names.length > 0
        ? nativeHooks.names.map((name) => join(nativeHooks.directory ?? ".git/hooks", name))
        : [nativeHooks.directory ?? ".git/hooks"];
      add(makeGate({
        id: "git-hooks:native", kind: "native-git-hook", sources: [], sourcePaths,
        tool: { name: "git", version: "unknown", available: true }, supported: false, availability: "unsupported",
        reason: nativeHooks.external
          ? "Native Git hooks use an external configured path; direct inspection and execution are unsupported."
          : "Native Git hooks remain owned by Git operations; direct execution would bypass operation context.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: true, precedence: 90,
      }));
    }

    checkCancelled();
    if (mise !== undefined) {
      for (const name of taskNames(mise.content, omissions)) {
        const identity = tool("mise", undefined, this.environment);
        add(makeGate({
          id: `mise:${name}`, kind: "mise", sources: [mise.source], sourcePaths: [mise.source.path], tool: identity,
          command: ["mise", "run", name], supported: true, availability: identity.available ? "available" : "missing_tool",
          ...(identity.available ? {} : { reason: "The mise executable is not available on PATH." }),
          coverage: { scope: "repository", paths: [] }, mayMutate: true, precedence: taskRank(name) >= PREFERRED_TASKS.length ? Number.MAX_SAFE_INTEGER : 40 + taskRank(name),
        }));
      }
    }

    checkCancelled();
    const packageJson = readConfig("package.json");
    for (const name of scriptNames(packageJson?.content, omissions)) {
      const identity = tool("npm", undefined, this.environment);
      add(makeGate({
        id: `npm:${name}`, kind: "npm", sources: packageJson === undefined ? [] : [packageJson.source], sourcePaths: packageJson === undefined ? [] : [packageJson.source.path], tool: identity,
        command: ["npm", "run", name], supported: true, availability: identity.available ? "available" : "missing_tool",
        ...(identity.available ? {} : { reason: "The npm executable is not available on PATH." }),
        coverage: { scope: "repository", paths: [] }, mayMutate: true, precedence: taskRank(name) >= PREFERRED_TASKS.length ? Number.MAX_SAFE_INTEGER : 50 + taskRank(name),
      }));
    }

    checkCancelled();
    const selected = gates.filter((candidate) => candidate.supported && candidate.command !== undefined && candidate.availability === "available" && candidate.precedence < Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id))[0];
    if (selected === undefined) {
      gates.push(makeGate({
        id: "no-gate", kind: "no-gate", sources: [], sourcePaths: [], tool: { name: "none", version: "none", available: false },
        supported: false, availability: "no_gate", reason: "No runnable repository quality gate was discovered.",
        coverage: { scope: "unknown", paths: [] }, mayMutate: false, precedence: Number.MAX_SAFE_INTEGER,
      }));
    }
    const sourceFiles = [...sources].sort((a, b) => a.path.localeCompare(b.path));
    const base: Omit<QualityGateProfile, "digest" | "discoveredAt"> = {
      version: 1, repositoryRoot: this.root, gitPolicy: gitPolicy(this.root, attributes?.source, this.environment), sourceFiles, gates, ...(selected === undefined ? {} : { selectedGateId: selected.id }),
      noGate: selected === undefined, omissions: [...new Set(omissions.map((omission) => redactText(omission)))].sort(),
    };
    return { ...base, discoveredAt: nowIso(), digest: profileDigest(base) };
  }

  async run(gateId: string, options: QualityGateRunOptions = {}): Promise<QualityGateRunResult> {
    let profile: QualityGateProfile;
    try {
      if (options.profile !== undefined && options.profile.repositoryRoot !== this.root) {
        throw new Error("The supplied quality-gate profile belongs to a different repository root.");
      }
      profile = options.profile ?? await this.discover(options.signal === undefined ? {} : { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted !== true) throw error;
      profile = noGateProfile(this.root, "Quality-gate discovery was cancelled.");
    }
    const gate = profile.gates.find((candidate) => candidate.id === gateId);
    const startedAt = nowIso();
    const started = performance.now();
    if (gate === undefined) {
      const fallback: QualityGate = {
        id: gateId, kind: "no-gate", sourcePaths: [], configDigest: sha256(""), tool: { name: "none", version: "none", available: false },
        supported: false, availability: "no_gate", coverage: { scope: "unknown", paths: [] }, mayMutate: false, precedence: Number.MAX_SAFE_INTEGER,
      };
      return emptyRun(fallback, profile, options.signal?.aborted === true ? "cancelled" : "blocked", options.signal?.aborted === true ? "Quality-gate discovery was cancelled." : "The requested quality gate was not discovered.", startedAt, started);
    }
    if (options.signal?.aborted === true) return emptyRun(gate, profile, "cancelled", "Quality-gate execution was cancelled before start.", startedAt, started);
    if (!gate.supported || gate.command === undefined) {
      const status: QualityGateRunStatus = gate.kind === "no-gate" || gate.availability === "conflicting" ? "blocked" : "unavailable";
      return emptyRun(gate, profile, status, gate.reason ?? "The discovered gate has no safe executable adapter.", startedAt, started);
    }
    const commandName = gate.command[0];
    if (commandName === undefined) return emptyRun(gate, profile, "blocked", "The discovered gate command is empty.", startedAt, started);
    const executable = findTool(commandName, this.environment);
    if (executable === undefined) return emptyRun(gate, profile, "unavailable", `The ${commandName} executable is unavailable.`, startedAt, started);

    const snapshotBefore = this.repository.snapshot();
    const changedPathsBefore = [...new Set(this.repository.rawChangedPaths())].sort();
    const coverage: QualityGateCoverage = options.changedPaths === undefined
      ? { ...gate.coverage, paths: [...gate.coverage.paths] }
      : { scope: "changed_paths", paths: [...new Set(options.changedPaths)].sort() };
    const processResult = await runProcess(executable, gate.command.slice(1), {
      cwd: this.root, environment: minimalEnvironment({ source: this.environment }), signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    });
    const snapshotAfter = this.repository.snapshot();
    const changedPathsAfter = [...new Set(this.repository.rawChangedPaths())].sort();
    const mutationDetected = snapshotBefore.dirtyFingerprint !== snapshotAfter.dirtyFingerprint
      || changedPathsBefore.join("\0") !== changedPathsAfter.join("\0");
    const status: QualityGateRunStatus = processResult.aborted ? "cancelled"
      : processResult.timedOut ? "timed_out"
      : mutationDetected ? "mutation_detected"
      : processResult.exitCode === 0 ? "passed" : "failed";
    const finishedAt = nowIso();
    return {
      version: 1, id: newId("quality-gate-run"), gateId, profileDigest: profile.digest, status, passed: status === "passed",
      command: [...gate.command], cwd: this.root, tool: { ...gate.tool, executable }, configDigest: gate.configDigest,
      coverage, mayMutate: gate.mayMutate,
      snapshotBefore, snapshotAfter, changedPathsBefore, changedPathsAfter, mutationDetected,
      exitCode: processResult.exitCode, ...(processResult.signal === undefined ? {} : { signal: processResult.signal }),
      stdout: redactText(processResult.stdout, this.environment), stderr: redactText(processResult.stderr, this.environment), stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated, startedAt, finishedAt, durationMs: performance.now() - started,
      ...(status === "mutation_detected" ? { reason: "The quality gate changed repository state." } : {}),
    };
  }
}

export function qualityGatePlanningInventory(profile: QualityGateProfile, plannedPaths: readonly string[]): QualityGatePlanInventory {
  const allPaths = [...new Set(plannedPaths)].sort();
  const normalizedPaths = allPaths.slice(0, MAX_PLANNED_PATHS);
  const runnable = profile.gates.filter((gate) => gate.supported && gate.availability === "available" && gate.command !== undefined && gate.precedence < Number.MAX_SAFE_INTEGER);
  const coverage = normalizedPaths.map((path) => {
    const relativePath = relative(profile.repositoryRoot, path).replaceAll("\\", "/");
    const gateIds = runnable.filter((gate) => gate.coverage.scope === "repository"
      || (gate.coverage.scope === "changed_paths" && gate.coverage.paths.some((candidate) => candidate === path || candidate === relativePath))).map((gate) => gate.id).sort();
    return { path, gateIds, covered: gateIds.length > 0 };
  });
  const missingPaths = coverage.filter((item) => !item.covered).map((item) => item.path);
  const unavailable = profile.gates.filter((gate) => gate.kind !== "no-gate" && gate.availability !== "available");
  const proposals = profile.noGate
    ? unavailable.length > 0
      ? [`Resolve unavailable repository checks before approving this plan: ${unavailable.map((gate) => gate.id).join(", ")}.`]
      : ["Configure a repository quality check before approving this plan."]
    : missingPaths.length > 0
      ? [`Add or extend repository check coverage for: ${missingPaths.join(", ")}.`]
      : [];
  const configDigest = sha256(stableJson({ sourceFiles: profile.sourceFiles, gitPolicy: profile.gitPolicy }));
  const gates: QualityGatePlanGate[] = profile.gates.filter((gate) => gate.kind !== "no-gate").map((gate) => ({
    id: gate.id,
    availability: gate.availability,
    supported: gate.supported,
    ...(gate.command === undefined ? {} : { command: [...gate.command] }),
    tool: { ...gate.tool },
    coverage: { ...gate.coverage, paths: [...gate.coverage.paths] },
    ...(gate.reason === undefined ? {} : { reason: gate.reason }),
  }));
  const base: Omit<QualityGatePlanInventory, "digest"> = {
    version: 1,
    profileDigest: profile.digest,
    configDigest,
    ...(profile.selectedGateId === undefined ? {} : { selectedGateId: profile.selectedGateId }),
    gates,
    plannedPaths: normalizedPaths,
    coverage,
    truncated: allPaths.length > MAX_PLANNED_PATHS,
    missingPaths,
    proposals,
  };
  return { ...base, digest: sha256(stableJson(base)) };
}

export function qualityGateSelection(profile: QualityGateProfile): QualityGate | undefined {
  return profile.gates.find((gate) => gate.id === profile.selectedGateId);
}
