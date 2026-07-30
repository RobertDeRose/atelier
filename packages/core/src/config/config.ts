import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "../domain/errors.ts";
import { isPathWithin } from "../security/path-boundary.ts";
import { sha256 } from "../util/hash.ts";
import { splitCommandLine } from "../util/command-line.ts";
import { establishSessionWorkspace } from "../workspace/session-workspace.ts";

export interface AtelierConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  workspaceSource: "startup_cwd" | "explicit";
  projectDirectory: string;
  projectConfigPath: string;
  validationPath: string;
  workspacePath: string;
  runtimeDirectory: string;
  /** @deprecated Runtime state directory alias retained for API compatibility. */
  stateDirectory: string;
  databasePath: string;
  planPath: string;
  editor?: string;
  taskProvider: "beads" | "memory" | "none";
  beadsCommand: string;
  repositoryProvider: "auto" | "jj" | "git";
  jjCommand: string;
  indexSchemaVersion: number;
  longRunningThresholdMs: number;
  codeProvider: "disabled" | "mock" | "codesearch" | "octocode";
  codeCommand: string;
  octocodeCommand: string;
  octocodeConfigPath: string;
  codeMode: "auto" | "local" | "client";
  codeTimeoutMs: number;
  codeIndexTimeoutMs: number;
  codeMaxResults: number;
  codeMaxPreviewBytes: number;
  codeMaxChunkBytes: number;
  codeMaxFetches: number;
  codeMaxTotalBytes: number;
  codeMaxProviderRequests: number;
  codeMaxUniquePaths: number;
  codeMaxEvidenceEntries: number;
  codeRetainedSessions: number;
  codeMaxPersistedEntries: number;
  codeMaxPersistedBytes: number;
  providerFirstRetrieval: "advisory" | "off";
  secretPathPatterns: string[];
  checkpointMaxBytes: number;
  footer: "atelier" | "status-only" | "disabled";
  sandboxBackend: "auto" | "seatbelt" | "bubblewrap" | "none";
}

export interface PartialAtelierConfig {
  runtimeDirectory?: string;
  stateDirectory?: string;
  databasePath?: string;
  planPath?: string;
  editor?: string;
  taskProvider?: AtelierConfig["taskProvider"];
  beadsCommand?: string;
  repositoryProvider?: AtelierConfig["repositoryProvider"];
  jjCommand?: string;
  indexSchemaVersion?: number;
  longRunningThresholdMs?: number;
  codeProvider?: AtelierConfig["codeProvider"];
  codeCommand?: string;
  octocodeCommand?: string;
  octocodeConfigPath?: string;
  codeMode?: AtelierConfig["codeMode"];
  codeTimeoutMs?: number;
  codeIndexTimeoutMs?: number;
  codeMaxResults?: number;
  codeMaxPreviewBytes?: number;
  codeMaxChunkBytes?: number;
  codeMaxFetches?: number;
  codeMaxTotalBytes?: number;
  codeMaxProviderRequests?: number;
  codeMaxUniquePaths?: number;
  codeMaxEvidenceEntries?: number;
  codeRetainedSessions?: number;
  codeMaxPersistedEntries?: number;
  codeMaxPersistedBytes?: number;
  providerFirstRetrieval?: AtelierConfig["providerFirstRetrieval"];
  secretPathPatterns?: string[];
  checkpointMaxBytes?: number;
  footer?: AtelierConfig["footer"];
  sandboxBackend?: AtelierConfig["sandboxBackend"];
}

function canonicalRoot(path: string): string {
  const root = resolve(path);
  return existsSync(root) ? realpathSync.native(root) : root;
}

export function userConfigPath(): string {
  return resolve(process.env.ATLR_USER_CONFIG ?? join(homedir(), ".config", "atelier", "config.json"));
}

export function defaultRuntimeDirectory(repositoryRoot: string): string {
  const stateHome = resolve(process.env.ATLR_STATE_HOME ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  return join(stateHome, "atelier", "repositories", sha256(canonicalRoot(repositoryRoot)).slice(0, 24));
}

function readJsonConfig(path: string): PartialAtelierConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed as PartialAtelierConfig;
  } catch (error) {
    throw new ConfigurationError(`Unable to parse Atelier configuration: ${path}`, { error });
  }
}

function mergeConfig(base: PartialAtelierConfig, override: PartialAtelierConfig): PartialAtelierConfig {
  return { ...base, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) };
}

function resolveFromRoot(root: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function requireProjectPath(root: string, value: string, field: string): string {
  const path = resolveFromRoot(root, value);
  if (!isPathWithin(path, root, "write")) {
    throw new ConfigurationError(`${field} must remain inside the project root: ${path}`);
  }
  return path;
}

function requireExternalRuntimePath(root: string, value: string, field: string): string {
  const path = resolve(value);
  if (isPathWithin(path, root, "write")) {
    throw new ConfigurationError(`${field} must remain outside the project root: ${path}`);
  }
  return path;
}

function validateChoice<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) throw new ConfigurationError(`${field} must be one of: ${allowed.join(", ")}`);
  return value;
}

export function loadConfig(repositoryRoot: string, options: { workspaceRoot?: string } = {}): AtelierConfig {
  const repository = canonicalRoot(repositoryRoot);
  const workspace = establishSessionWorkspace(repositoryRoot, options.workspaceRoot);
  const root = repository;
  if (!isPathWithin(root, workspace.root, "read")) throw new ConfigurationError(`Repository root must remain inside the Atelier workspace: ${root}`);
  const projectDirectory = resolve(root, ".atelier");
  const projectConfigPath = resolve(projectDirectory, "config.json");
  const userConfig = readJsonConfig(userConfigPath());
  const repositoryConfig = readJsonConfig(projectConfigPath);
  const merged = mergeConfig(userConfig, repositoryConfig);

  const runtimeValue = userConfig.runtimeDirectory ?? userConfig.stateDirectory;
  const runtimeDirectory = requireExternalRuntimePath(root, runtimeValue ?? defaultRuntimeDirectory(root), "runtimeDirectory");
  const databasePath = requireExternalRuntimePath(root, userConfig.databasePath ?? join(runtimeDirectory, "atelier.db"), "databasePath");
  const planPath = requireProjectPath(root, merged.planPath ?? ".atelier/PLAN.md", "planPath");
  const validationPath = resolve(projectDirectory, "validation.json");
  const workspacePath = resolve(projectDirectory, "workspace.json");

  const repositoryProvider = validateChoice(merged.repositoryProvider ?? "auto", ["auto", "jj", "git"] as const, "repositoryProvider");
  const taskProvider = validateChoice(merged.taskProvider ?? "beads", ["beads", "memory", "none"] as const, "taskProvider");
  const codeProvider = validateChoice(merged.codeProvider ?? "codesearch", ["disabled", "mock", "codesearch", "octocode"] as const, "codeProvider");
  const codeMode = validateChoice(merged.codeMode ?? "auto", ["auto", "local", "client"] as const, "codeMode");
  const providerFirstRetrieval = validateChoice(merged.providerFirstRetrieval ?? "advisory", ["advisory", "off"] as const, "providerFirstRetrieval");
  const footer = validateChoice(merged.footer ?? "atelier", ["atelier", "status-only", "disabled"] as const, "footer");
  const sandboxBackend = validateChoice(merged.sandboxBackend ?? "auto", ["auto", "seatbelt", "bubblewrap", "none"] as const, "sandboxBackend");

  const octocodeConfigPath = userConfig.octocodeConfigPath !== undefined
    ? resolveFromRoot(root, userConfig.octocodeConfigPath)
    : requireProjectPath(root, repositoryConfig.octocodeConfigPath ?? ".atelier/octocode-config.toml", "octocodeConfigPath");
  const editor = process.env.ATLR_EDITOR ?? merged.editor;
  return {
    repositoryRoot: root,
    workspaceRoot: root,
    workspaceSource: workspace.source,
    projectDirectory, projectConfigPath, validationPath, workspacePath, runtimeDirectory, stateDirectory: runtimeDirectory, databasePath, planPath,
    ...(editor === undefined ? {} : { editor }),
    taskProvider, beadsCommand: merged.beadsCommand ?? "bd", repositoryProvider, jjCommand: merged.jjCommand ?? "jj",
    indexSchemaVersion: merged.indexSchemaVersion ?? 1, longRunningThresholdMs: merged.longRunningThresholdMs ?? 300_000,
    codeProvider, codeCommand: merged.codeCommand ?? "codesearch", octocodeCommand: merged.octocodeCommand ?? "octocode", octocodeConfigPath, codeMode,
    codeTimeoutMs: merged.codeTimeoutMs ?? 60_000, codeIndexTimeoutMs: merged.codeIndexTimeoutMs ?? 300_000,
    codeMaxResults: merged.codeMaxResults ?? 10, codeMaxPreviewBytes: merged.codeMaxPreviewBytes ?? 2_000, codeMaxChunkBytes: merged.codeMaxChunkBytes ?? 16_000,
    codeMaxFetches: merged.codeMaxFetches ?? 8, codeMaxTotalBytes: merged.codeMaxTotalBytes ?? 64_000, codeMaxProviderRequests: merged.codeMaxProviderRequests ?? 8,
    codeMaxUniquePaths: merged.codeMaxUniquePaths ?? 32, codeMaxEvidenceEntries: merged.codeMaxEvidenceEntries ?? 64, codeRetainedSessions: merged.codeRetainedSessions ?? 4,
    codeMaxPersistedEntries: merged.codeMaxPersistedEntries ?? 256, codeMaxPersistedBytes: merged.codeMaxPersistedBytes ?? 256_000, providerFirstRetrieval,
    secretPathPatterns: Array.isArray(merged.secretPathPatterns) ? merged.secretPathPatterns.filter((value): value is string => typeof value === "string") : [],
    checkpointMaxBytes: Number.isFinite(merged.checkpointMaxBytes) && (merged.checkpointMaxBytes ?? 0) > 0 ? merged.checkpointMaxBytes! : 16 * 1024 * 1024,
    footer, sandboxBackend,
  };
}

export interface EditorCommand {
  executable: string;
  args: string[];
  source: "atlr" | "pi" | "VISUAL" | "EDITOR" | "fallback";
}

function readPiExternalEditor(repositoryRoot: string, piProjectTrusted: boolean): string | undefined {
  const candidates: string[] = [join(homedir(), ".pi", "agent", "settings.json")];
  if (piProjectTrusted) candidates.unshift(join(repositoryRoot, ".pi", "settings.json"));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { externalEditor?: unknown };
      if (typeof parsed.externalEditor === "string" && parsed.externalEditor.trim()) {
        return parsed.externalEditor;
      }
    } catch {
      // Pi reports malformed Pi settings itself. Atelier does not execute them.
    }
  }
  return undefined;
}

export function resolveEditorCommand(config: AtelierConfig, piProjectTrusted = false): EditorCommand {
  const candidates: Array<[string | undefined, EditorCommand["source"]]> = [
    [config.editor, "atlr"],
    [readPiExternalEditor(config.repositoryRoot, piProjectTrusted), "pi"],
    [process.env.VISUAL, "VISUAL"],
    [process.env.EDITOR, "EDITOR"],
    [platform() === "win32" ? "notepad" : "nano", "fallback"],
  ];

  for (const [candidate, source] of candidates) {
    if (!candidate?.trim()) continue;
    const parts = splitCommandLine(candidate);
    const executable = parts.shift();
    if (executable) return { executable, args: parts, source };
  }

  throw new ConfigurationError("No editor command is configured");
}
