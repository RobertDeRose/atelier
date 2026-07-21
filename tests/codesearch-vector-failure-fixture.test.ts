import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-vector-failure/${name}.json`, "utf8")) as T;
}

test("real codesearch 1.1.30 fixture records vector-store failure without hiding literal capabilities", () => {
  const contract = fixture<{ calls?: Record<string, { content?: Array<{ text?: string }>; isError?: boolean }> }>("mcp_contract");
  const semanticText = contract.calls?.search?.content?.[0]?.text ?? "";
  assert.match(semanticText, /Error searching vector store: Error opening database for read fallback/);
  assert.equal(contract.calls?.search?.isError, false);

  const symbols = fixture<Array<{ path?: string }>>("symbols");
  assert.ok(symbols.some((item) => item.path === "packages/core/src/core.ts"));

  const conformance = fixture<{ totals?: { failed?: number; warnings?: number }; checks?: Array<{ name?: string; status?: string }> }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.equal(conformance.totals?.warnings, 4);
  assert.ok(conformance.checks?.some((check) => check.name === "search_results" && check.status === "warning"));

  const evaluation = fixture<{ aggregate?: { codesearch?: { meanWeightedRecall?: number } } }>("evaluation");
  assert.equal(evaluation.aggregate?.codesearch?.meanWeightedRecall, 0);

  const serialized = JSON.stringify({ contract, symbols, conformance, evaluation });
  assert.doesNotMatch(serialized, /DeRoseR/);
});
