import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter } from "node:path";
import { minimalEnvironment } from "../process/environment.ts";
import { runProcess, type ProcessResult } from "../process/async-process.ts";

export type SandboxBackend = "auto" | "seatbelt" | "bubblewrap" | "none";
export interface SandboxStatus { backend: Exclude<SandboxBackend, "auto">; available: boolean; detail: string }

function executableOnPath(name: string): boolean {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) if (entry && existsSync(`${entry}/${name}`)) return true;
  return false;
}

export function resolveSandboxBackend(requested: SandboxBackend = "auto"): SandboxStatus {
  if (requested === "none") return { backend: "none", available: false, detail: "Sandbox explicitly disabled." };
  if ((requested === "auto" || requested === "seatbelt") && platform() === "darwin" && executableOnPath("sandbox-exec")) {
    return { backend: "seatbelt", available: true, detail: "macOS Seatbelt via sandbox-exec" };
  }
  if ((requested === "auto" || requested === "bubblewrap") && platform() === "linux" && executableOnPath("bwrap")) {
    return { backend: "bubblewrap", available: true, detail: "Linux Bubblewrap" };
  }
  return { backend: requested === "auto" ? "none" : requested, available: false, detail: `Requested sandbox backend is unavailable on ${platform()}.` };
}

function seatbeltProfile(workspace: string, allowNetwork: boolean): string {
  const escaped = workspace.replaceAll('"', '\\"');
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
    "(allow file-read*)", `(allow file-write* (subpath \"${escaped}\"))`,
    '(deny file-read* (subpath "~/.ssh"))', '(deny file-read* (subpath "~/.aws"))',
    allowNetwork ? "(allow network*)" : "(deny network*)",
  ].join(" ");
}

export function sandboxCommand(status: SandboxStatus, workspace: string, command: string, allowNetwork = false): { command: string; args: string[] } {
  if (!status.available) throw new Error(status.detail);
  if (status.backend === "seatbelt") return { command: "sandbox-exec", args: ["-p", seatbeltProfile(workspace, allowNetwork), "/bin/sh", "-lc", command] };
  if (status.backend === "bubblewrap") return {
    command: "bwrap",
    args: ["--die-with-parent", "--unshare-all", ...(allowNetwork ? ["--share-net"] : []), "--ro-bind", "/", "/", "--bind", workspace, workspace, "--tmpfs", "/tmp", "--chdir", workspace, "/bin/sh", "-lc", command],
  };
  throw new Error("No sandbox backend is active.");
}

export async function runSandboxedShell(options: { workspace: string; command: string; backend?: SandboxBackend; allowNetwork?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<ProcessResult & { sandbox: SandboxStatus }> {
  const sandbox = resolveSandboxBackend(options.backend);
  const invocation = sandboxCommand(sandbox, options.workspace, options.command, options.allowNetwork ?? false);
  const result = await runProcess(invocation.command, invocation.args, {
    cwd: options.workspace,
    environment: minimalEnvironment({ overrides: { ATELIER_WORKSPACE_ROOT: options.workspace } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? 120_000,
    idleTimeoutMs: 30_000,
  });
  return { ...result, sandbox };
}
