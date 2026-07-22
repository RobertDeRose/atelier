import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-vector-repaired/${name}.json`, "utf8")) as T;
}

test("real codesearch fixture records successful vector repair and semantic recovery", () => {
  const conformance = fixture<{
    totals?: { passed?: number; warnings?: number; failed?: number };
    checks?: Array<{ name?: string; status?: string; detail?: string }>;
  }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.ok((conformance.totals?.passed ?? 0) >= 40);
  assert.equal(conformance.checks?.find((check) => check.name === "vector_index_built")?.status, "passed");
  assert.match(conformance.checks?.find((check) => check.name === "vector_index_repaired")?.detail ?? "", /1006 chunks/);
  assert.equal(conformance.checks?.find((check) => check.name === "semantic_health")?.status, "passed");
  assert.equal(conformance.checks?.find((check) => check.name === "hybrid_health")?.status, "passed");

  const stats = fixture<string>("codesearch_stats_after");
  assert.match(stats, /Total chunks:\s*16327/);
  assert.match(stats, /Indexed:\s*✅ Yes/);

  const evaluation = fixture<{
    aggregate?: { codesearch?: { degradedResultCount?: number; warnings?: string[] } };
  }>("evaluation");
  assert.equal(evaluation.aggregate?.codesearch?.degradedResultCount, 0);
  assert.deepEqual(evaluation.aggregate?.codesearch?.warnings, []);

  const serialized = JSON.stringify({ conformance, stats, evaluation });
  assert.doesNotMatch(serialized, /DeRoseR/);
  assert.doesNotMatch(serialized, /\/Users\/(?!<USER>)/);
});
