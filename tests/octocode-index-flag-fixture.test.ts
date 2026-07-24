import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("real Octocode 0.14.0 fixture records that index --force is unsupported", () => {
  const root = resolve("tests/fixtures/octocode-index-flag");
  const setup = JSON.parse(readFileSync(resolve(root, "setup_config.json"), "utf8")) as { codeModel: string | null; textModel: string | null };
  const environment = JSON.parse(readFileSync(resolve(root, "embedding_environment.json"), "utf8")) as { configured: boolean; provider: string };
  const conformance = JSON.parse(readFileSync(resolve(root, "conformance.json"), "utf8")) as { checks: Array<{ name: string; status: string; detail: string }> };
  assert.equal(environment.configured, true);
  assert.equal(environment.provider, "fastembed");
  assert.equal(setup.codeModel, null);
  assert.equal(setup.textModel, null);
  const index = conformance.checks.find((check) => check.name === "index");
  const adapter = conformance.checks.find((check) => check.name === "adapter_index");
  assert.equal(index?.status, "failed");
  assert.match(index?.detail ?? "", /unexpected argument '--force'/);
  assert.match(adapter?.detail ?? "", /unexpected argument '--force'/);
});
