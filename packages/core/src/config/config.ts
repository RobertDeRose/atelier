import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "../domain/errors.ts";
import { splitCommandLine } from "../util/command-line.ts";

export interface AtelierConfig {
  repositoryRoot: string;
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
  codeProvider: "disabled" | "mock" | "codesearch";
  codeCommand: string;
  codeMode: "auto" | "local" | "client";
  codeTimeoutMs: number;
  codeIndexTimeoutMs: number;
  codeMaxResults: number;
  codeMaxPreviewBytes: number;
  codeMaxChunkBytes: number;
  codeMaxFetches: number;
  codeMaxTotalBytes: number;
}

interface PartialAtelierConfig {
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
  codeMode?: AtelierConfig["codeMode"];
  codeTimeoutMs?: number;
  codeIndexTimeoutMs?: number;
  codeMaxResults?: number;
  codeMaxPreviewBytes?: number;
  codeMaxChunkBytes?: number;
  codeMaxFetches?: number;
  codeMaxTotalBytes?: number;
}

function readJsonConfig(path: string): PartialAtelierConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialAtelierConfig;
  } catch (error) {
    throw new ConfigurationError(`Unable to parse Atelier configuration: ${path}`, { error });
  }
}

function mergeConfig(base: PartialAtelierConfig, override: PartialAtelierConfig): PartialAtelierConfig {
  return { ...base, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) };
}

function resolveFromRoot(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

export function loadConfig(repositoryRoot: string): AtelierConfig {
  const root = resolve(repositoryRoot);
  const userConfig = readJsonConfig(join(homedir(), ".config", "atelier", "config.json"));
  const repositoryConfig = readJsonConfig(join(root, ".atelier", "config.json"));
  const merged = mergeConfig(userConfig, repositoryConfig);
  const stateDirectory = resolveFromRoot(root, merged.stateDirectory ?? ".atelier");

  const editor = process.env.ATLR_EDITOR ?? merged.editor;
  return {
    repositoryRoot: root,
    stateDirectory,
    databasePath: resolveFromRoot(root, merged.databasePath ?? join(stateDirectory, "atelier.db")),
    planPath: resolveFromRoot(root, merged.planPath ?? join(stateDirectory, "PLAN.md")),
    ...(editor === undefined ? {} : { editor }),
    taskProvider: merged.taskProvider ?? "beads",
    beadsCommand: merged.beadsCommand ?? "bd",
    repositoryProvider: merged.repositoryProvider ?? "auto",
    jjCommand: merged.jjCommand ?? "jj",
    indexSchemaVersion: merged.indexSchemaVersion ?? 1,
    longRunningThresholdMs: merged.longRunningThresholdMs ?? 300_000,
    codeProvider: merged.codeProvider ?? "codesearch",
    codeCommand: merged.codeCommand ?? "codesearch",
    codeMode: merged.codeMode ?? "auto",
    codeTimeoutMs: merged.codeTimeoutMs ?? 60_000,
    codeIndexTimeoutMs: merged.codeIndexTimeoutMs ?? 300_000,
    codeMaxResults: merged.codeMaxResults ?? 10,
    codeMaxPreviewBytes: merged.codeMaxPreviewBytes ?? 2_000,
    codeMaxChunkBytes: merged.codeMaxChunkBytes ?? 16_000,
    codeMaxFetches: merged.codeMaxFetches ?? 8,
    codeMaxTotalBytes: merged.codeMaxTotalBytes ?? 64_000,
  };
}

export interface EditorCommand {
  executable: string;
  args: string[];
  source: "atlr" | "pi" | "VISUAL" | "EDITOR" | "fallback";
}

function readPiExternalEditor(repositoryRoot: string, projectTrusted: boolean): string | undefined {
  const candidates: string[] = [join(homedir(), ".pi", "agent", "settings.json")];
  if (projectTrusted) candidates.unshift(join(repositoryRoot, ".pi", "settings.json"));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { externalEditor?: unknown };
      if (typeof parsed.externalEditor === "string" && parsed.externalEditor.trim()) {
        return parsed.externalEditor;
      }
    } catch {
      // Pi will report malformed Pi settings itself. Atelier simply falls through.
    }
  }
  return undefined;
}

export function resolveEditorCommand(config: AtelierConfig, projectTrusted = false): EditorCommand {
  const candidates: Array<[string | undefined, EditorCommand["source"]]> = [
    [config.editor, "atlr"],
    [readPiExternalEditor(config.repositoryRoot, projectTrusted), "pi"],
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
