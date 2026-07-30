import type { AtelierConfig, EditorCommand } from "../config/config.ts";
import { resolveEditorCommand } from "../config/config.ts";
import { minimalEnvironment } from "./environment.ts";
import { runProcess } from "./async-process.ts";

export interface InteractiveProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  signal?: NodeJS.Signals;
  error?: string;
}

export async function runInteractiveProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
}): Promise<InteractiveProcessResult> {
  const args = options.args ?? [];
  try {
    const result = await runProcess(options.command, args, {
      cwd: options.cwd,
      environment: options.environment ?? minimalEnvironment(),
      signal: options.signal,
      inheritStdio: true,
    });
    return { command: options.command, args, exitCode: result.exitCode, ...(result.signal ? { signal: result.signal } : {}) };
  } catch (error) {
    return { command: options.command, args, exitCode: 1, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runConfiguredEditor(options: {
  config: AtelierConfig;
  path: string;
  projectTrusted?: boolean;
  signal?: AbortSignal | undefined;
}): Promise<InteractiveProcessResult & { editor: EditorCommand }> {
  const editor = resolveEditorCommand(options.config, options.projectTrusted ?? false);
  const result = await runInteractiveProcess({
    command: editor.executable,
    args: [...editor.args, options.path],
    cwd: options.config.repositoryRoot,
    signal: options.signal,
  });
  return { ...result, editor };
}
