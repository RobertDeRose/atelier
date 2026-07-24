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


test("Octocode collector preflights embeddings, preserves the contract, and gates GraphRAG", () => {
  const script = readFileSync(resolve("scripts/collect-octocode-knowledge.sh"), "utf8");
  assert.match(script, /export OCTOCODE_CONFIG_PATH=/);
  assert.match(script, /run setup_config node .*setup-octocode-development\.ts/);
  assert.match(script, /run config_show octocode config --show/);
  assert.match(script, /run embedding_environment node .*inspect-octocode-environment\.ts/);
  assert.doesNotMatch(script, /octocode index --force/);
  assert.match(script, /run index octocode index/);
  assert.match(script, /indexing was skipped to avoid a long unsuccessful run/);
  assert.match(script, /code search "Where is code provider selection implemented\?" --provider octocode --mode semantic --focus source --json=true/);
  assert.match(script, /code symbols "OctocodeProvider" --provider octocode --json=true/);
  assert.match(script, /code index --provider octocode --json=true/);
  assert.match(script, /grep -q '"name": "graphrag"'/);
  assert.match(script, /graphrag was not advertised by Octocode/);
});
