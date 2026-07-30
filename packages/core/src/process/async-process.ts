import { spawn } from "node:child_process";
import { minimalEnvironment } from "./environment.ts";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunProcessOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  inheritStdio?: boolean | undefined;
  onData?: ((chunk: string) => void) | undefined;
}

export async function runProcess(command: string, args: readonly string[], options: RunProcessOptions): Promise<ProcessResult> {
  const maximum = Math.max(1024, options.maxOutputBytes ?? 64 * 1024);
  return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let totalTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment ?? minimalEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: options.inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
    });

    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { try { child.kill(signal); } catch { /* exited */ } }
    };
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if ((options.idleTimeoutMs ?? 0) > 0) {
        idleTimer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); }, options.idleTimeoutMs);
        idleTimer.unref?.();
      }
    };
    const append = (current: string, chunk: Buffer): [string, boolean] => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) <= maximum) return [next, false];
      return [next.slice(-maximum), true];
    };
    const abort = (): void => { aborted = true; terminate("SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if ((options.timeoutMs ?? 0) > 0) {
      totalTimer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); }, options.timeoutMs);
      totalTimer.unref?.();
    }
    resetIdle();
    if (!options.inheritStdio) {
      child.stdout?.on("data", (chunk: Buffer) => { [stdout, stdoutTruncated] = append(stdout, chunk); options.onData?.(chunk.toString("utf8")); resetIdle(); });
      child.stderr?.on("data", (chunk: Buffer) => { [stderr, stderrTruncated] = append(stderr, chunk); options.onData?.(chunk.toString("utf8")); resetIdle(); });
      if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ stdout, stderr, exitCode: code ?? (aborted || timedOut ? 130 : 1), ...(signal ? { signal } : {}), timedOut, aborted, stdoutTruncated, stderrTruncated });
    });
    const cleanup = (): void => {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const scheduleForce = (): void => {
      forceTimer = setTimeout(() => terminate("SIGKILL"), 1_000);
      forceTimer.unref?.();
    };
    child.once("spawn", () => {
      if (aborted || timedOut) { terminate("SIGTERM"); scheduleForce(); }
    });
  });
}
