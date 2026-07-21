import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("real codesearch 1.1.30 probe fixture remains portable and records asynchronous indexing", () => {
  const fixture = JSON.parse(readFileSync("tests/fixtures/codesearch-real/status_after.json", "utf8")) as {
    status?: { identity?: { version?: string }; indexState?: string; capabilities?: string[]; detail?: string };
  };
  assert.equal(fixture.status?.identity?.version, "1.1.30");
  assert.equal(fixture.status?.indexState, "building");
  assert.ok(fixture.status?.capabilities?.includes("result.fetch_on_demand"));
  assert.match(fixture.status?.detail ?? "", /Mode: self-contained/);
  assert.doesNotMatch(JSON.stringify(fixture), /DeRoseR/);
});
