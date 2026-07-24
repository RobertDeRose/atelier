import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/octocode-evaluated/${name}`, "utf8")) as T;
}

test("Octocode comparative evaluation rejects default retrieval while preserving the structural contract", () => {
  const conformance = fixture<{
    totals: { passed: number; warnings: number; failed: number };
    checks: Array<{ name: string; status: string }>;
  }>("conformance.json");
  assert.equal(conformance.totals.failed, 0);
  assert.equal(conformance.totals.warnings, 1);
  assert.ok(conformance.totals.passed >= 33);
  assert.equal(conformance.checks.find((check) => check.name === "evaluation:complete")?.status, "passed");
  assert.equal(conformance.checks.find((check) => check.name === "evaluation:octocode_quality")?.status, "warning");

  const evaluation = fixture<{
    aggregate: {
      baseline: { tasks: number; durationMs: number; meanWeightedRecall: number; meanReciprocalRank: number; meanNdcgAt10: number };
      codesearch: { tasks: number; durationMs: number; meanWeightedRecall: number; meanReciprocalRank: number; meanNdcgAt10: number };
      octocode: { tasks: number; durationMs: number; meanWeightedRecall: number; meanReciprocalRank: number; meanNdcgAt10: number; degradedResultCount: number };
    };
  }>("evaluation.json");
  const { baseline, codesearch, octocode } = evaluation.aggregate;
  assert.equal(baseline.tasks, 4);
  assert.equal(codesearch.tasks, baseline.tasks);
  assert.equal(octocode.tasks, baseline.tasks);
  assert.equal(baseline.meanWeightedRecall, 1);
  assert.equal(codesearch.meanWeightedRecall, baseline.meanWeightedRecall);
  assert.equal(codesearch.meanReciprocalRank, 1);
  assert.ok(codesearch.meanNdcgAt10 > baseline.meanNdcgAt10);
  assert.equal(octocode.meanWeightedRecall, 0.2009);
  assert.equal(octocode.meanReciprocalRank, 0.375);
  assert.equal(octocode.meanNdcgAt10, 0.2323);
  assert.equal(octocode.degradedResultCount, 0);
  assert.ok(octocode.durationMs > codesearch.durationMs * 5);
});
