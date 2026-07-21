import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AtelierCore } from "../packages/core/src/index.ts";

test("validation evidence is snapshot-qualified and becomes stale after edits", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-validation-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".atelier"));
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: { pass: { command: [process.execPath, "-e", "process.exit(0)"] } } }));
  writeFileSync(join(root, "source.txt"), "one\n");
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  try {
    const snapshot = core.repository.snapshot();
    const evidence = core.validation.run("pass", snapshot);
    assert.equal(evidence.status, "passed");
    assert.equal(core.validation.list({ currentSnapshot: snapshot })[0]?.stale, false);
    writeFileSync(join(root, "source.txt"), "two\n");
    assert.equal(core.validation.list({ currentSnapshot: core.repository.snapshot() })[0]?.stale, true);
  } finally { core.close(); }
});


test("focused validation selection uses changed paths and symbols", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-focused-validation-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".atelier"));
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: {
    types: { command: [process.execPath, "-e", "process.exit(0)"], paths: ["src/**/*.ts"] },
    state: { command: [process.execPath, "-e", "process.exit(0)"], symbols: ["WorkingState*"] },
    smoke: { command: [process.execPath, "-e", "process.exit(0)"], focused: true },
  } }));
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  try {
    const plan = core.validation.planFocused(["src/core/state.ts"], ["WorkingStateBuilder"]);
    assert.deepEqual(plan.map((item) => item.name).sort(), ["smoke", "state", "types"]);
  } finally { core.close(); }
});
