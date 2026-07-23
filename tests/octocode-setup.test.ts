import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Octocode development setup creates a project-local FastEmbed configuration without changing global config", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-setup-"));
  const bin = join(root, "bin");
  const command = join(bin, "octocode");
  const log = join(root, "calls.jsonl");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(command, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config: process.env.OCTOCODE_CONFIG_PATH }) + '\\n');
if (args[0] !== 'config') process.exit(2);
const get = name => args[args.indexOf(name) + 1];
const target = process.env.OCTOCODE_CONFIG_PATH;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, 'version = 1\\n\\n[embedding]\\ncode_model = "' + get('--code-embedding-model') + '"\\ntext_model = "' + get('--text-embedding-model') + '"\\n\\n[graphrag]\\nenabled = true\\nuse_llm = false\\n');
`, "utf8");
  chmodSync(command, 0o755);
  try {
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", resolve("scripts/setup-octocode-development.ts"), root], {
      cwd: resolve("."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const config = join(root, ".atelier", "octocode-config.toml");
    assert.equal(existsSync(config), true);
    assert.match(readFileSync(config, "utf8"), /fastembed:jinaai\/jina-embeddings-v2-base-code/);
    assert.match(readFileSync(config, "utf8"), /fastembed:nomic-ai\/nomic-embed-text-v1\.5/);
    assert.match(readFileSync(config, "utf8"), /enabled = true/);
    const call = JSON.parse(readFileSync(log, "utf8").trim()) as { config: string; args: string[] };
    assert.equal(call.config, config);
    assert.ok(call.args.includes("--graphrag-enabled"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
