import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("tests/fixtures/octocode-0.14.0/mcp_contract.json", "utf8")) as {
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, { maximum?: number }> } }>;
};

test("real Octocode 0.14.0 contract bounds semantic results and omits GraphRAG when disabled", () => {
  const names = contract.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["semantic_search", "structural_search", "view_signatures"]);
  const semantic = contract.tools.find((tool) => tool.name === "semantic_search");
  assert.equal(semantic?.inputSchema?.properties?.max_results?.maximum, 20);
  assert.equal(names.includes("graphrag"), false);
});
