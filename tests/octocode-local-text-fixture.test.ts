import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("tests/fixtures/octocode-local-text/mcp_contract.json", "utf8")) as {
  tools: Array<{ name: string }>;
  calls: Record<string, { content?: Array<{ text?: string }>; isError?: boolean; error?: string }>;
};
const conformance = JSON.parse(readFileSync("tests/fixtures/octocode-local-text/conformance.json", "utf8")) as { totals: { failed: number }; checks: Array<{ name: string; detail: string }> };

test("real Octocode 0.14.0 local fixture returns text MCP evidence that requires normalization", () => {
  assert.deepEqual(contract.tools.map((tool) => tool.name), ["graphrag", "semantic_search", "structural_search", "view_signatures"]);
  assert.match(contract.calls.semantic_search?.content?.[0]?.text ?? "", /CODE RESULTS \(1\)/);
  assert.match(contract.calls.view_signatures?.content?.[0]?.text ?? "", /SIGNATURES \(2 files\)/);
  assert.match(contract.calls.graphrag?.error ?? "", /missing field `operation`/);
  assert.equal(conformance.totals.failed, 2);
  assert.equal(conformance.checks.find((check) => check.name === "search:results")?.detail, "0 result(s)");
});
