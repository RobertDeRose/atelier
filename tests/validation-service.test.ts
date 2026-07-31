import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AtelierCore, DisabledCodeProvider } from "../packages/core/src/index.ts";

function validationRoot(prefix: string, validations: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".atelier"));
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations }));
  writeFileSync(join(root, "source.txt"), "one\n");
  return root;
}

test("validation evidence is asynchronous, snapshot-qualified, and explains staleness after edits", async () => {
  const root = validationRoot("atelier-validation-", {
    pass: { command: [process.execPath, "-e", "process.exit(0)"], focused: true, required: true },
  });
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    const snapshot = core.currentValidationSnapshot();
    const evidence = await core.validation.run("pass", snapshot);
    assert.equal(evidence.status, "passed");
    assert.equal(core.validation.list({ currentSnapshot: snapshot })[0]?.stale, false);
    writeFileSync(join(root, "source.txt"), "two\n");
    const stale = core.validation.list({
      currentSnapshot: core.currentValidationSnapshot(),
      currentChangedPaths: core.repository.changedPaths(),
    })[0];
    assert.equal(stale?.stale, true);
    assert.match(stale?.staleReason ?? "", /fingerprint.*source\.txt/i);

    const rerun = await core.validation.run("pass", core.currentValidationSnapshot());
    assert.equal(rerun.status, "passed");
    assert.equal(core.validation.list({ currentSnapshot: core.currentValidationSnapshot() })[0]?.stale, false);
  } finally { await core.close(); }
});

test("validation persists failed and interrupted outcomes with bounded output and no child process", async () => {
  const pidPath = join(tmpdir(), "atlr-validation-child-pid");
  const root = validationRoot("atelier-validation-process-", {
    fail: {
      command: [process.execPath, "-e", "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000)); process.exit(2)"],
    },
    wait: {
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`],
    },
  });
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    const failed = await core.validation.run("fail", core.repository.snapshot(), { maxOutputBytes: 256 });
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 2);
    assert.equal(failed.stdoutTruncated, true);
    assert.equal(failed.stderrTruncated, true);
    assert.ok(Buffer.byteLength(failed.stdout) <= 256);
    assert.ok(Buffer.byteLength(failed.stderr) <= 256);

    rmSync(pidPath, { force: true });
    const controller = new AbortController();
    const pending = core.validation.run("wait", core.repository.snapshot(), { signal: controller.signal });
    while (!existsSync(pidPath)) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const interrupted = await pending;
    assert.equal(interrupted.status, "interrupted");
    assert.notEqual(interrupted.status, "passed");
    const childPid = Number(readFileSync(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(childPid, 0));
  } finally { await core.close(); }
});

test("focused validation selection is explainable, persisted, and never promotes no-match to full suite", async () => {
  const root = validationRoot("atelier-focused-validation-", {
    types: { command: [process.execPath, "-e", "process.exit(0)"], paths: ["src/**/*.ts"], focused: true, required: true },
    state: { command: [process.execPath, "-e", "process.exit(0)"], symbols: ["WorkingState*"], focused: true },
    smoke: { command: [process.execPath, "-e", "process.exit(0)"], focused: true },
    full: { command: [process.execPath, "-e", "process.exit(0)"], category: "full", required: true },
  });
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    const plan = core.validation.planFocused(["src/core/state.ts"], ["WorkingStateBuilder"]);
    assert.deepEqual(plan.map((item) => item.name).sort(), ["smoke", "state", "types"]);
    assert.equal(plan.find((item) => item.name === "types")?.required, true);
    assert.equal(plan.some((item) => item.name === "full"), false);

    const noMatch = core.validation.saveFocusedSelection({
      taskId: "task",
      executionGrantId: "execution",
      planHash: "plan",
      reconciliationDigest: "reconciliation",
      snapshot: core.repository.snapshot(),
      changedPaths: ["docs/readme.md"],
      changedSymbols: [],
    });
    assert.equal(noMatch.noMatch, false, "default focused smoke remains selected");
    assert.equal(noMatch.selected.some((item) => item.name === "full"), false);

    writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: {
      full: { command: [process.execPath, "-e", "process.exit(0)"], category: "full", required: true },
    } }));
    const empty = core.validation.saveFocusedSelection({
      taskId: "task",
      executionGrantId: "execution",
      planHash: "plan",
      reconciliationDigest: "reconciliation",
      snapshot: core.repository.snapshot(),
      changedPaths: ["source.txt"],
      changedSymbols: [],
    });
    assert.equal(empty.noMatch, true);
    assert.deepEqual(empty.selected, []);
    assert.equal(core.validation.listFocusedSelections({ taskId: "task" })[0]?.id, empty.id);
  } finally { await core.close(); }
});
