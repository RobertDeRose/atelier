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
  const timeout = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: process.cwd(), timeoutMs: 30 });
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const aborted = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: process.cwd(), signal: controller.signal });
  assert.equal(aborted.aborted, true);
});
