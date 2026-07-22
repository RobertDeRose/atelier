import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-identifier-hints/${name}.json`, "utf8")) as T;
}

test("real codesearch fixture records successful semantic and literal fusion before hint refinement", () => {
  const conformance = fixture<{
    totals?: { passed?: number; warnings?: number; failed?: number };
    checks?: Array<{ name?: string; status?: string; detail?: string }>;
  }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.ok((conformance.totals?.passed ?? 0) >= 45);
  assert.equal(conformance.checks?.find((check) => check.name === "retrieval_fusion")?.status, "passed");
  assert.equal(conformance.checks?.find((check) => check.name === "fixture_pollution")?.status, "passed");

  const evaluation = fixture<{
    aggregate?: {
      baseline?: { meanWeightedRecall?: number };
      codesearch?: { degradedResultCount?: number; fusionResultCount?: number; meanWeightedRecall?: number; warnings?: string[] };
    };
  }>("evaluation");
  assert.equal(evaluation.aggregate?.codesearch?.degradedResultCount, 0);
  assert.deepEqual(evaluation.aggregate?.codesearch?.warnings, []);
  assert.equal(evaluation.aggregate?.codesearch?.fusionResultCount, 8);
  assert.equal(evaluation.aggregate?.codesearch?.meanWeightedRecall, 0.8571);
  assert.ok((evaluation.aggregate?.codesearch?.meanWeightedRecall ?? 0) < (evaluation.aggregate?.baseline?.meanWeightedRecall ?? 0));

  const search = fixture<Array<{ path?: string; retrievalMethods?: string[] }>>("search");
  assert.equal(search[0]?.path, "packages/core/src/code/registry.ts");
  assert.deepEqual(search[0]?.retrievalMethods?.sort(), ["lexical", "semantic"]);

  const serialized = JSON.stringify({ conformance, evaluation, search });
  assert.doesNotMatch(serialized, /DeRoseR/);
  assert.doesNotMatch(serialized, /\/Users\/(?!<USER>)/);
});
