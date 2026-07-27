import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTemporaryRepository } from "./fixtures.ts";

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    join(process.cwd(), "apps", "cli", "src", "main.ts"),
    "--root", root,
    ...args,
  ], { encoding: "utf8", shell: false });
}

test("CLI code JSON keeps decision, telemetry, provenance, scope, invalidation, and truncation stable", () => {
  const root = createTemporaryRepository("atlr-cli-retrieval-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
    codeMaxResults: 1,
  }));
  try {
    const search = run(root, ["code", "search", "MissingSymbol", "--mode", "semantic", "--json"]);
    assert.equal(search.status, 0, search.stderr);
    const payload = JSON.parse(search.stdout) as any;
    assert.ok(Array.isArray(payload.results));
    assert.equal(payload.decision.kind, "provider_call");
    assert.equal(typeof payload.telemetry.providerCalls, "number");
    assert.equal(typeof payload.telemetry.cacheHits, "number");
    assert.equal(typeof payload.telemetry.uniquePaths, "number");
    assert.equal(typeof payload.telemetry.duplicateResultsRemoved, "number");
    assert.equal(typeof payload.telemetry.bytesReturned, "number");
    assert.equal(typeof payload.truncation.truncated, "boolean");
    assert.ok(Array.isArray(payload.invalidations));
    assert.ok(Array.isArray(payload.provenance));
    assert.equal(typeof payload.scope.workspaceId, "string");
    assert.ok(Array.isArray(payload.scope.repositoryIds));
    assert.equal(typeof payload.inventory.freshness, "string");

    const status = run(root, ["code", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as any;
    assert.equal(typeof statusPayload.status.identity.name, "string");
    assert.equal(typeof statusPayload.retrieval.sessionId, "string");
    assert.ok(Array.isArray(statusPayload.retrieval.evidence));
    assert.ok(Array.isArray(statusPayload.retrieval.decisions));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI code text output includes inventory, reuse decision, and remaining budgets", () => {
  const root = createTemporaryRepository("atlr-cli-retrieval-text-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
  }));
  try {
    const result = run(root, ["code", "search", "MissingSymbol"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Retrieval session:/);
    assert.match(result.stdout, /Decision: provider_call/);
    assert.match(result.stdout, /Remaining provider requests:/);
    assert.match(result.stdout, /Inventory:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
