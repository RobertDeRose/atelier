import { spawn } from "node:child_process";
import { minimalEnvironment } from "./environment.ts";

const EXIT_STDIO_GRACE_MS = 100;

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

/**
 * Run one bounded subprocess without blocking the JavaScript event loop.
 *
 * A short-lived shell can exit while a detached descendant still holds its
 * stdout or stderr pipe open. Waiting only for ChildProcess `close` makes an
 * otherwise completed Pi tool appear to hang indefinitely. After a normal
 * process exit, keep draining output until both streams end or they remain idle
 * for a short bounded grace period. Timeout and abort paths still retain their
 * force-kill timer so a descendant cannot escape process-group termination.
 */
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
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | undefined;
    let terminationForced = false;
    let stdoutEnded = options.inheritStdio === true;
    let stderrEnded = options.inheritStdio === true;
    let totalTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let postExitTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment ?? minimalEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: options.inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
    });

    if (!options.inheritStdio) {
      stdoutEnded = child.stdout === null;
      stderrEnded = child.stderr === null;
    }

    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* exited */ }
      }
    };

    const cleanup = (): void => {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (postExitTimer !== undefined) clearTimeout(postExitTimer);
      options.signal?.removeEventListener("abort", abort);
    };

    const finalize = (code = exitCode, signal = exitSignal): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? (aborted || timedOut ? 130 : 1),
        ...(signal === undefined ? {} : { signal }),
        timedOut,
        aborted,
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const maybeFinalizeAfterExit = (): void => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize();
    };

    const armPostExitTimer = (): void => {
      if (!exited || settled) return;
      // A timeout/abort must retain the SIGKILL escalation until the process
      // group has either closed its streams or the force timer has fired.
      if ((timedOut || aborted) && !terminationForced) return;
      if (postExitTimer !== undefined) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(), EXIT_STDIO_GRACE_MS);
      postExitTimer.unref?.();
    };

    const scheduleForce = (): void => {
      if (forceTimer !== undefined || settled) return;
      forceTimer = setTimeout(() => {
        terminationForced = true;
        terminate("SIGKILL");
        armPostExitTimer();
      }, 1_000);
      forceTimer.unref?.();
    };

    const requestTermination = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      terminate("SIGTERM");
      scheduleForce();
    };

    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if ((options.idleTimeoutMs ?? 0) > 0) {
        idleTimer = setTimeout(() => requestTermination("timeout"), options.idleTimeoutMs);
        idleTimer.unref?.();
      }
    };

    const append = (current: string, chunk: Buffer): [string, boolean] => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) <= maximum) return [next, false];
      return [next.slice(-maximum), true];
    };

    const onOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") [stdout, stdoutTruncated] = append(stdout, chunk);
      else [stderr, stderrTruncated] = append(stderr, chunk);
      options.onData?.(chunk.toString("utf8"));
      resetIdle();
      if (exited) armPostExitTimer();
    };

    const abort = (): void => requestTermination("abort");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if ((options.timeoutMs ?? 0) > 0) {
      totalTimer = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
      totalTimer.unref?.();
    }
    resetIdle();

    if (!options.inheritStdio) {
      child.stdout?.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => onOutput("stderr", chunk));
      child.stdout?.once("end", () => { stdoutEnded = true; maybeFinalizeAfterExit(); });
      child.stderr?.once("end", () => { stderrEnded = true; maybeFinalizeAfterExit(); });
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // A short-lived child may exit before Node flushes stdin. EPIPE and
        // ECONNRESET describe that normal race; the authoritative process
        // result still arrives through exit/close.
        if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal ?? undefined;
      maybeFinalizeAfterExit();
      armPostExitTimer();
    });
    child.once("close", (code, signal) => {
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;
      finalize(exitCode, exitSignal);
    });
    child.once("spawn", () => {
      if (aborted || timedOut) {
        terminate("SIGTERM");
        scheduleForce();
      }
    });
  });
}
