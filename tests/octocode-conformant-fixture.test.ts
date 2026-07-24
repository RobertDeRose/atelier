import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function json<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/octocode-conformant/${name}`, "utf8")) as T;
}

test("real Octocode 0.14.0 project-local run satisfies the complete provider contract", () => {
  const conformance = json<{
    totals: { passed: number; warnings: number; failed: number };
    toolNames: string[];
    checks: Array<{ name: string; status: string; detail: string }>;
  }>("conformance.json");
  assert.equal(conformance.totals.failed, 0);
  assert.equal(conformance.totals.warnings, 0);
  assert.ok(conformance.totals.passed >= 30);
  assert.deepEqual(conformance.toolNames, ["graphrag", "semantic_search", "structural_search", "view_signatures"]);
  assert.equal(conformance.checks.find((check) => check.name === "search:results")?.status, "passed");
  assert.equal(conformance.checks.find((check) => check.name === "symbols:results")?.status, "passed");
  assert.equal(conformance.checks.find((check) => check.name === "call:graphrag")?.status, "passed");

  const search = json<Array<{ path?: string; provenance?: { provider?: { name?: string }; freshness?: string } }>>("search.json");
  assert.ok(search.length > 0);
  assert.equal(search[0]?.provenance?.provider?.name, "octocode");
  assert.equal(search[0]?.provenance?.freshness, "current");

  const symbols = json<Array<{ path?: string }>>("symbols.json");
  assert.ok(symbols.some((row) => row.path === "packages/core/src/code/octocode-provider.ts"));

  const related = json<Array<{ kind?: string; target?: { path?: string } }>>("related.json");
  assert.ok(related.length > 0);
  assert.ok(related.every((row) => row.kind === "imports"));
});
