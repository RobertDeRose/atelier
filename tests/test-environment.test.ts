import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import { createTemporaryRepository } from "./fixtures.ts";

test("the deterministic suite excludes workstation Git signing and still creates commit fixtures", () => {
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(
    process.execArgv.includes("--test-concurrency=8"),
    "the deterministic suite must bound test-file concurrency",
  );
  assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, undefined);
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  assert.ok(globalConfig, "tests/test-environment.ts must provide an isolated global Git configuration");
  assert.equal(existsSync(globalConfig), true);

  const signing = spawnSync("git", ["config", "--global", "--bool", "commit.gpgSign"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(signing.status, 0, signing.stderr);
  assert.equal(signing.stdout.trim(), "false");

  const root = createTemporaryRepository("atlr-hermetic-git-");
  try {
    const log = spawnSync("git", ["log", "-1", "--format=%s"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(log.status, 0, log.stderr);
    assert.equal(log.stdout.trim(), "test: initialize repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
