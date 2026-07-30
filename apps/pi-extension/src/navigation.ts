import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { AtelierCore, EditorCommand } from "../../../packages/core/src/index.ts";

export interface FileLocation { path: string; line?: number }

export function parseFileLocation(value: string, cwd: string): FileLocation {
  const trimmed = value.trim();
  const match = /^(.*?):(\d+)$/.exec(trimmed);
  const path = resolve(cwd, match?.[1] ?? trimmed);
  return { path, ...(match?.[2] === undefined ? {} : { line: Number(match[2]) }) };
}

export function editorArguments(editor: EditorCommand, location: FileLocation): string[] {
  if (location.line === undefined) return [...editor.args, location.path];
  const executable = editor.executable.split(/[\\/]/).at(-1) ?? editor.executable;
  if (["hx", "helix"].includes(executable)) return [...editor.args, `${location.path}:${location.line}`];
  if (["vim", "nvim", "vi"].includes(executable)) return [...editor.args, `+${location.line}`, location.path];
  if (["code", "zed"].includes(executable)) return [...editor.args, "--goto", `${location.path}:${location.line}`];
  return [...editor.args, location.path];
}

export function commandOnPath(name: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((entry) => entry && existsSync(resolve(entry, name)));
}

export function projectTree(core: AtelierCore, limit = 250): string[] {
  return core.repository.listFiles().slice(0, limit).map((path) => {
    const depth = path.split("/").length - 1;
    return `${"  ".repeat(depth)}${path.split("/").at(-1)}`;
  });
}
