import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../packages/core/src/process/async-process.ts";

test("async process runner captures bounded output and exit status", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"], { cwd: process.cwd(), timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.timedOut, false);
});

test("async process runner distinguishes timeout and cancellation", async () => {
  const timeout = await runProcess(
    process.execPath,
    ["-e", "process.stderr.write('started before timeout'); setTimeout(() => {}, 10000)"],
    // The aggregate suite starts many Node fixtures concurrently. Give the
    // child enough time to start and emit its diagnostic before exercising
    // total-timeout termination; a 200 ms wall-clock assumption is not a
    // process-runner contract and flakes under scheduler pressure.
    { cwd: process.cwd(), timeoutMs: 2_000 },
  );
  assert.equal(timeout.timedOut, true);
  assert.match(timeout.stderr, /started before timeout/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const aborted = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: process.cwd(), signal: controller.signal });
  assert.equal(aborted.aborted, true);
});

test("async process runner force-kills a timed-out process group that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const startedAt = Date.now();
  const result = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); process.stderr.write('ignoring SIGTERM'); setInterval(() => {}, 10000)"],
    { cwd: process.cwd(), timeoutMs: 1_000 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.match(result.stderr, /ignoring SIGTERM/);
  assert.ok(Date.now() - startedAt < 4_000, "force termination exceeded the bounded grace period");
});

test("async process runner completes after parent exit when a detached descendant holds stdio open", { skip: process.platform === "win32" }, async () => {
  const startedAt = Date.now();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });",
    "child.unref();",
    "process.stdout.write('parent complete');",
  ].join("\n");
  const result = await runProcess(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "parent complete");
  assert.ok(Date.now() - startedAt < 2_000, "runner waited for a detached descendant to release inherited stdio");
});
