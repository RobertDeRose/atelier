import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function runSetup(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", resolve("scripts/setup-octocode-development.ts"), root], {
    cwd: resolve("."),
    env: { ...process.env },
    encoding: "utf8",
  });
}

test("Octocode development setup writes a project-local FastEmbed configuration without invoking global config", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-setup-"));
  try {
    const result = runSetup(root);
    assert.equal(result.status, 0, String(result.stderr));
    const config = join(root, ".atelier", "octocode-config.toml");
    const marker = join(root, ".atelier", "octocode-config.managed.json");
    assert.equal(existsSync(config), true);
    assert.equal(existsSync(marker), true);
    assert.match(readFileSync(config, "utf8"), /fastembed:jinaai\/jina-embeddings-v2-base-code/);
    assert.match(readFileSync(config, "utf8"), /fastembed:nomic-ai\/nomic-embed-text-v1\.5/);
    assert.match(readFileSync(config, "utf8"), /\[graphrag\][\s\S]*enabled = true/);
    const report = JSON.parse(String(result.stdout)) as { configPath: string; codeModel: string; textModel: string; graphRagEnabled: boolean; created: boolean };
    assert.equal(report.configPath, config);
    assert.equal(report.codeModel, "fastembed:jinaai/jina-embeddings-v2-base-code");
    assert.equal(report.textModel, "fastembed:nomic-ai/nomic-embed-text-v1.5");
    assert.equal(report.graphRagEnabled, true);
    assert.equal(report.created, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Octocode development setup preserves an unmanaged project configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-user-config-"));
  const config = join(root, ".atelier", "octocode-config.toml");
  try {
    spawnSync("mkdir", ["-p", join(root, ".atelier")]);
    const custom = 'version = 1\n\n[embedding]\ncode_model = "openai:text-embedding-3-small"\ntext_model = "openai:text-embedding-3-small"\n';
    writeFileSync(config, custom, "utf8");
    const result = runSetup(root);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(readFileSync(config, "utf8"), custom);
    const report = JSON.parse(String(result.stdout)) as { managed: boolean; updated: boolean };
    assert.equal(report.managed, false);
    assert.equal(report.updated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
