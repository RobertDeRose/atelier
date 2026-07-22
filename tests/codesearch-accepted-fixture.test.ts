import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-accepted/${name}.json`, "utf8")) as T;
}

test("accepted codesearch evaluation matches baseline recall with better ranking", () => {
  const conformance = fixture<{ totals?: { passed?: number; warnings?: number; failed?: number }; checks?: Array<{ name?: string; status?: string }> }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.equal(conformance.totals?.warnings, 1);
  assert.ok((conformance.totals?.passed ?? 0) >= 46);
  assert.equal(conformance.checks?.find((check) => check.name === "retrieval_quality")?.status, "passed");

  const evaluation = fixture<{ aggregate?: { baseline?: { meanWeightedRecall?: number; meanReciprocalRank?: number; meanNdcgAt10?: number }; codesearch?: { meanWeightedRecall?: number; meanReciprocalRank?: number; meanNdcgAt10?: number } } }>("evaluation");
  assert.equal(evaluation.aggregate?.codesearch?.meanWeightedRecall, evaluation.aggregate?.baseline?.meanWeightedRecall);
  assert.ok((evaluation.aggregate?.codesearch?.meanReciprocalRank ?? 0) > (evaluation.aggregate?.baseline?.meanReciprocalRank ?? 0));
  assert.ok((evaluation.aggregate?.codesearch?.meanNdcgAt10 ?? 0) > (evaluation.aggregate?.baseline?.meanNdcgAt10 ?? 0));
});
