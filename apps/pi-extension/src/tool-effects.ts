import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FilesystemEffect } from "../../../packages/core/src/index.ts";

function commandText(event: any): string {
  return typeof event.input?.command === "string" ? event.input.command.trim() : "";
}

function shellEffects(command: string, cwd: string): FilesystemEffect[] {
  if (/^(?:sudo|doas|su|pkexec)(?:\s|$)/.test(command)) {
    return [{ kind: "privilege_escalation", description: command }];
  }
  const effects: FilesystemEffect[] = [];
  const redirection = /(?:^|\s)(>>|>|1>|2>)\s*([^\s;&|]+)/g;
  for (const match of command.matchAll(redirection)) {
    const path = resolve(cwd, match[2]!);
    effects.push({
      kind: match[1] === ">>" ? "mutate" : existsSync(path) ? "overwrite" : "create",
      path,
      destructive: match[1] !== ">>",
      preservesPrevious: match[1] === ">>",
      description: `shell redirection ${match[1]}`,
    });
  }
  const rm = command.match(/(?:^|[;&|]\s*|\s)rm\s+(?:-[^\s]+\s+)*([^;&|]+)/);
  if (rm) for (const token of rm[1]!.trim().split(/\s+/).filter((value) => !value.startsWith("-"))) {
    effects.push({ kind: "delete", path: resolve(cwd, token), destructive: true, description: "rm target" });
  }
  const truncate = command.match(/(?:^|\s)(?:truncate\b[^\n]*?|git\s+(?:restore|checkout)\b[^\n]*?|jj\s+restore\b[^\n]*?)(?:--\s+)?([^\s;&|]+)$/);
  if (truncate?.[1]) effects.push({ kind: "overwrite", path: resolve(cwd, truncate[1]), destructive: true, description: "destructive replacement" });
  if (effects.length > 0) return effects;
  if (/^(?:git|jj)\s+(?:status|diff|log|show|root|workspace\s+root|op\s+log)\b/.test(command)
    || /^(?:cat|head|tail|sed\s+-n|rg|grep|find|fd|ls|pwd)\b/.test(command)) {
    return [{ kind: "read", path: cwd, description: "bounded shell read" }];
  }
  return [{ kind: "unknown", description: command || "empty shell command" }];
}

export function effectsForTool(event: any, ctx: ExtensionContext): FilesystemEffect[] {
  const path = typeof event.input?.path === "string" ? resolve(ctx.cwd, event.input.path) : undefined;
  if (["read", "grep", "find", "ls"].includes(event.toolName)) {
    const target = path ?? (typeof event.input?.directory === "string" ? resolve(ctx.cwd, event.input.directory) : ctx.cwd);
    return [{ kind: "read", path: target, description: `${event.toolName} target` }];
  }
  if (event.toolName === "write") {
    if (path === undefined) return [{ kind: "unknown", description: "write without a path" }];
    return [{ kind: existsSync(path) ? "overwrite" : "create", path, destructive: existsSync(path), preservesPrevious: false, description: "typed write" }];
  }
  if (event.toolName === "edit") {
    return path === undefined
      ? [{ kind: "unknown", description: "edit without a path" }]
      : [{ kind: existsSync(path) ? "mutate" : "create", path, preservesPrevious: true, description: "typed edit" }];
  }
  if (event.toolName === "bash") return shellEffects(commandText(event), ctx.cwd);
  if (event.toolName.startsWith("atlr_code_") || event.toolName === "atlr_state") {
    return [{ kind: "read", path: ctx.cwd, description: `Atelier ${event.toolName} read` }];
  }
  if (event.toolName === "atlr_validate") return [{ kind: "execute", path: ctx.cwd, description: "declared validation" }];
  if (event.toolName === "atlr_commit" || event.toolName === "atlr_task_close") return [{ kind: "mutate", path: ctx.cwd, preservesPrevious: true, description: event.toolName }];
  return [{ kind: "unknown", description: `custom tool ${String(event.toolName)}` }];
}

export function effectsForUserBash(command: string, cwd: string): FilesystemEffect[] {
  return shellEffects(command, cwd);
}
