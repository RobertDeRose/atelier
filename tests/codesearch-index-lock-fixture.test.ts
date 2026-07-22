import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-index-lock/${name}.json`, "utf8")) as T;
}

test("real codesearch fixture records the MCP writer lock that blocked local repair", () => {
  const conformance = fixture<{
    totals?: { failed?: number };
    checks?: Array<{ name?: string; status?: string; detail?: string }>;
  }>("conformance");
  assert.ok((conformance.totals?.failed ?? 0) >= 1);
  assert.equal(conformance.checks?.find((check) => check.name === "index")?.status, "failed");
  assert.match(conformance.checks?.find((check) => check.name === "vector_index_built")?.detail ?? "", /not indexed \(1006 chunks\)/);

  const stats = fixture<string>("codesearch_stats_after");
  assert.match(stats, /Total chunks:\s*1006/);
  assert.match(stats, /Indexed:\s*❌ No/);

  const search = fixture<Array<{ provenance?: { degraded?: boolean; warnings?: string[] } }>>("search");
  assert.ok(search.length > 0);
  assert.equal(search[0]?.provenance?.degraded, true);
  assert.match(search[0]?.provenance?.warnings?.[0] ?? "", /Error opening database for read fallback/);

  const serialized = JSON.stringify({ conformance, stats, search });
  assert.doesNotMatch(serialized, /DeRoseR/);
  assert.doesNotMatch(serialized, /\/Users\/(?!<USER>)/);
});
