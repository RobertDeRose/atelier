import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-unbuilt-vector/${name}.json`, "utf8")) as T;
}

test("real codesearch 1.1.30 fixture proves MCP ready can coexist with an unbuilt HNSW index", () => {
  const stats = fixture<string>("codesearch_stats");
  assert.match(stats, /Total chunks: 1191/);
  assert.match(stats, /Indexed: ❌ No/);

  const doctor = fixture<string>("codesearch_doctor");
  assert.match(doctor, /Vector store empty - no chunks indexed/);
  assert.match(doctor, /Run 'codesearch index'/);

  const status = fixture<{ status?: { indexState?: string } }>("status_after");
  assert.equal(status.status?.indexState, "ready");

  const automatic = fixture<Array<{ provenance?: { actualMode?: string; degraded?: boolean; warnings?: string[] } }>>("search");
  assert.ok(automatic.length > 0);
  assert.equal(automatic[0]?.provenance?.actualMode, "lexical");
  assert.equal(automatic[0]?.provenance?.degraded, true);
  assert.match(automatic[0]?.provenance?.warnings?.[0] ?? "", /Error opening database for read fallback/);

  const directSearch = fixture<string>("direct_search");
  assert.equal(directSearch, "");

  const serialized = JSON.stringify({ stats, doctor, status, automatic });
  assert.doesNotMatch(serialized, /DeRoseR/);
});
