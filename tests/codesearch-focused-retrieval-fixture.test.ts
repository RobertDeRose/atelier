import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-focused-retrieval/${name}.json`, "utf8")) as T;
}

test("real codesearch fixture records focused retrieval before lexical fusion", () => {
  const conformance = fixture<{
    totals?: { passed?: number; warnings?: number; failed?: number };
    checks?: Array<{ name?: string; status?: string; detail?: string }>;
  }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.ok((conformance.totals?.passed ?? 0) >= 44);
  assert.equal(conformance.checks?.find((check) => check.name === "fixture_pollution")?.status, "passed");
  assert.equal(conformance.checks?.find((check) => check.name === "implementation_focus")?.status, "passed");
  assert.equal(conformance.checks?.find((check) => check.name === "semantic_health")?.status, "passed");

  const evaluation = fixture<{
    aggregate?: {
      baseline?: { meanWeightedRecall?: number };
      codesearch?: { degradedResultCount?: number; meanWeightedRecall?: number; meanReciprocalRank?: number; warnings?: string[] };
    };
  }>("evaluation");
  assert.equal(evaluation.aggregate?.codesearch?.degradedResultCount, 0);
  assert.deepEqual(evaluation.aggregate?.codesearch?.warnings, []);
  assert.equal(evaluation.aggregate?.codesearch?.meanWeightedRecall, 0.5625);
  assert.equal(evaluation.aggregate?.codesearch?.meanReciprocalRank, 0.875);
  assert.ok((evaluation.aggregate?.baseline?.meanWeightedRecall ?? 0) > (evaluation.aggregate?.codesearch?.meanWeightedRecall ?? 1));

  const stats = fixture<string>("codesearch_stats_after");
  assert.match(stats, /Total chunks:\s*2229/);
  assert.match(stats, /Indexed:\s*✅ Yes/);

  const serialized = JSON.stringify({ conformance, evaluation, stats });
  assert.doesNotMatch(serialized, /DeRoseR/);
  assert.doesNotMatch(serialized, /\/Users\/(?!<USER>)/);
});
