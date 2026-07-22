import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("codesearch excludes committed provider evidence from repository retrieval", () => {
  const ignore = readFileSync(".codesearchignore", "utf8");
  assert.match(ignore, /^tests\/fixtures\/codesearch-\*\//m);
  assert.match(ignore, /^\.atelier\//m);
  assert.match(ignore, /^\.codesearch\.db\//m);
});
