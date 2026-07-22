import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Octocode collector diagnoses a missing development binary before invoking probe commands", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-collector-"));
  const out = join(root, "probe");
  const archive = join(root, "knowledge.tar.xz");
  try {
    const result = spawnSync("bash", [resolve("scripts/collect-octocode-knowledge.sh"), root, out, archive], {
      cwd: resolve("."),
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(existsSync(archive), true);
    assert.match(readFileSync(join(out, "SUMMARY.md"), "utf8"), /expects Muvon Octocode 0\.14\.0/);
    assert.equal(existsSync(join(out, "version.stderr")), false);
    assert.doesNotMatch(result.stderr, /command not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
