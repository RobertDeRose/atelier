import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTemporaryRepository } from "./fixtures.ts";

test("temporary repositories ignore hostile workstation commit-signing configuration", () => {
  const control = mkdtempSync(join(tmpdir(), "atlr-host-git-config-"));
  const signer = join(control, "failing-signer");
  const marker = join(control, "signer-invoked");
  const config = join(control, "gitconfig");
  writeFileSync(signer, `#!/bin/sh\nprintf invoked >${JSON.stringify(marker)}\nexit 1\n`, "utf8");
  chmodSync(signer, 0o755);
  writeFileSync(config, [
    "[user]",
    "\tname = Host User",
    "\temail = host@example.invalid",
    "\tsigningKey = hostile-test-key",
    "[commit]",
    "\tgpgSign = true",
    "[tag]",
    "\tgpgSign = true",
    "[gpg]",
    `\tprogram = ${signer}`,
    "",
  ].join("\n"), "utf8");

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  let root: string | undefined;
  try {
    root = createTemporaryRepository("atlr-isolated-git-fixture-");
    const log = spawnSync("git", ["log", "-1", "--format=%s"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(log.status, 0, log.stderr);
    assert.equal(log.stdout.trim(), "test: initialize repository");
    assert.throws(() => readFileSync(marker, "utf8"));
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});
