import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { platform } from "node:os";
import { delimiter } from "node:path";
import { isPathWithin, resolveAccessPath } from "../security/path-boundary.ts";
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
  const home = homedir().replaceAll('"', '\\"');
  const protectedPaths = [".ssh", ".aws", ".gnupg", ".netrc", ".npmrc", ".pypirc"]
    .map((path) => `${home}/${path}`);
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
    "(allow file-read*)",
    ...protectedPaths.map((path) => `(deny file-read* (subpath "${path}"))`),
    `(allow file-write* (subpath "${escaped}"))`,
    allowNetwork ? "(allow network*)" : "(deny network*)",
  ].join(" ");
}

function bubblewrapSecretMasks(): string[] {
  const home = homedir();
  const masks: string[] = [];
  for (const path of [".ssh", ".aws", ".gnupg"]) {
    const absolute = `${home}/${path}`;
    if (existsSync(absolute)) masks.push("--tmpfs", absolute);
  }
  for (const path of [".netrc", ".npmrc", ".pypirc"]) {
    const absolute = `${home}/${path}`;
    if (existsSync(absolute)) masks.push("--ro-bind", "/dev/null", absolute);
  }
  return masks;
}

export function sandboxCommand(status: SandboxStatus, workspace: string, command: string, allowNetwork = false, cwd = workspace): { command: string; args: string[] } {
  if (!status.available) throw new Error(status.detail);
  if (status.backend === "seatbelt") return { command: "sandbox-exec", args: ["-p", seatbeltProfile(workspace, allowNetwork), "/bin/sh", "-lc", command] };
  if (status.backend === "bubblewrap") return {
    command: "bwrap",
    args: ["--die-with-parent", "--unshare-all", ...(allowNetwork ? ["--share-net"] : []), "--ro-bind", "/", "/", ...bubblewrapSecretMasks(), "--bind", workspace, workspace, "--tmpfs", "/tmp", "--chdir", cwd, "/bin/sh", "-lc", command],
  };
  throw new Error("No sandbox backend is active.");
}

export async function runSandboxedShell(options: { workspace: string; command: string; cwd?: string; backend?: SandboxBackend; allowNetwork?: boolean; allowUnsandboxed?: boolean; signal?: AbortSignal; timeoutMs?: number; onData?: (chunk: string) => void }): Promise<ProcessResult & { sandbox: SandboxStatus }> {
  const workspace = resolveAccessPath(options.workspace, "write");
  const cwd = resolveAccessPath(options.cwd ?? workspace, "write");
  if (!isPathWithin(cwd, workspace, "write")) throw new Error(`Shell working directory escapes the Atelier workspace: ${cwd}`);
  const sandbox = resolveSandboxBackend(options.backend);
  const invocation = sandbox.available
    ? sandboxCommand(sandbox, workspace, options.command, options.allowNetwork ?? false, cwd)
    : options.allowUnsandboxed === true
      ? { command: "/bin/sh", args: ["-lc", options.command] }
      : (() => { throw new Error(sandbox.detail); })();
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    environment: minimalEnvironment({ overrides: { ATELIER_WORKSPACE_ROOT: workspace } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.onData === undefined ? {} : { onData: options.onData }),
    idleTimeoutMs: 30_000,
  });
  return { ...result, sandbox };
}
