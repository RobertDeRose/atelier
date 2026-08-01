import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const smoke = join(process.cwd(), "scripts", "smoke.sh");
const cancellationReadyTimeoutMs = 60_000;
const cancellationExitTimeoutMs = 10_000;

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function empty(path: string): boolean {
  return readdirSync(path).length === 0;
}

async function waitForPathOrExit(
  path: string,
  getExit: () => ChildExit | undefined,
  getError: () => Error | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    if (getExit() !== undefined || getError() !== undefined) return false;
    await delay(25);
  }
  return existsSync(path);
}

function boundedOutput(value: string): string {
  const limit = 4_096;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function forceStopProcessGroup(child: ChildProcess, exited: Promise<ChildExit>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, "SIGKILL");
  await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
}

test("smoke repositories are removed after success, failure, and cancellation", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-smoke-cleanup-"));
  try {
    const successTmp = join(root, "success");
    const failureTmp = join(root, "failure");
    const cancellationTmp = join(root, "cancellation");
    const successLog = join(root, "success-path");
    const failureLog = join(root, "failure-path");
    const cancellationLog = join(root, "cancellation-path");
    for (const path of [successTmp, failureTmp, cancellationTmp]) mkdirSync(path, { recursive: true });

    const success = spawnSync("bash", [smoke], {
      encoding: "utf8",
      shell: false,
      env: { ...process.env, TMPDIR: successTmp, ATLR_SMOKE_TMP_LOG: successLog },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(empty(successTmp), true);
    assert.equal(existsSync(readFileSync(successLog, "utf8").trim()), false);

    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeNode = join(fakeBin, "node");
    writeFileSync(fakeNode, "#!/usr/bin/env bash\nexit 17\n", "utf8");
    chmodSync(fakeNode, 0o755);
    const failure = spawnSync("bash", [smoke], {
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: failureTmp,
        ATLR_SMOKE_TMP_LOG: failureLog,
      },
    });
    assert.notEqual(failure.status, 0);
    assert.equal(empty(failureTmp), true);
    assert.equal(existsSync(readFileSync(failureLog, "utf8").trim()), false);

    const marker = join(root, "node-started");
    const blockingNode = [
      "#!/usr/bin/env bash",
      `touch ${JSON.stringify(marker)}`,
      "trap 'exit 130' TERM INT HUP",
      "while true; do sleep 1; done",
      "",
    ].join("\n");
    writeFileSync(fakeNode, blockingNode, "utf8");
    chmodSync(fakeNode, 0o755);

    let child: ChildProcess | undefined;
    let exited: Promise<ChildExit> | undefined;
    let exitState: ChildExit | undefined;
    let spawnError: Error | undefined;
    let stdout = "";
    let stderr = "";
    try {
      child = spawn("bash", [smoke], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: cancellationTmp,
          ATLR_SMOKE_TMP_LOG: cancellationLog,
        },
      });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      exited = new Promise<ChildExit>((resolve) => {
        child?.once("exit", (code, signal) => {
          exitState = { code, signal };
          resolve(exitState);
        });
      });

      const ready = await waitForPathOrExit(
        marker,
        () => exitState,
        () => spawnError,
        cancellationReadyTimeoutMs,
      );
      assert.equal(
        ready,
        true,
        [
          `smoke process did not reach the cancellation point within ${cancellationReadyTimeoutMs} ms`,
          `spawn error: ${spawnError?.message ?? "none"}`,
          `exit: ${JSON.stringify(exitState ?? null)}`,
          `stdout: ${boundedOutput(stdout) || "<empty>"}`,
          `stderr: ${boundedOutput(stderr) || "<empty>"}`,
        ].join("\n"),
      );
      assert.ok(child.pid);

      signalProcessGroup(child, "SIGTERM");
      const exit = await Promise.race([
        exited,
        delay(cancellationExitTimeoutMs, undefined, { ref: false }).then(() => undefined),
      ]);
      if (exit === undefined) {
        await forceStopProcessGroup(child, exited);
      }
      assert.notEqual(exit, undefined, "cancelled smoke process must exit promptly");
      assert.equal(empty(cancellationTmp), true);
      assert.equal(existsSync(readFileSync(cancellationLog, "utf8").trim()), false);
    } finally {
      if (child !== undefined && exited !== undefined) await forceStopProcessGroup(child, exited);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
