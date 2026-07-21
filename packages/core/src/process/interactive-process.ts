import { spawnSync } from "node:child_process";
import type { AtelierConfig, EditorCommand } from "../config/config.ts";
import { resolveEditorCommand } from "../config/config.ts";

export interface InteractiveProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  signal?: NodeJS.Signals;
  error?: string;
}

export function runInteractiveProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
}): InteractiveProcessResult {
  const args = options.args ?? [];
  const result = spawnSync(options.command, args, {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  return {
    command: options.command,
    args,
    exitCode: result.status ?? 1,
    ...(result.signal === null ? {} : { signal: result.signal }),
    ...(result.error === undefined ? {} : { error: result.error.message }),
  };
}

export function runConfiguredEditor(options: {
  config: AtelierConfig;
  path: string;
  projectTrusted?: boolean;
}): InteractiveProcessResult & { editor: EditorCommand } {
  const editor = resolveEditorCommand(options.config, options.projectTrusted ?? false);
  const result = runInteractiveProcess({
    command: editor.executable,
    args: [...editor.args, options.path],
    cwd: options.config.repositoryRoot,
  });
  return { ...result, editor };
}
