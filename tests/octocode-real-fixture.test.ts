import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("tests/fixtures/octocode-real/mcp_contract.json", "utf8")) as { initialize: { serverInfo: { version: string } }; tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };

test("real Octocode 0.14.0 fixture preserves the advertised MCP contract", () => {
  assert.equal(fixture.initialize.serverInfo.version, "0.14.0");
  const names = fixture.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["semantic_search", "structural_search", "view_signatures"]);
  assert.equal(names.includes("graphrag"), false);
  const semantic = fixture.tools.find((tool) => tool.name === "semantic_search")!;
  assert.ok(semantic.inputSchema.properties?.max_results);
  assert.ok(semantic.inputSchema.properties?.detail_level);
  const signatures = fixture.tools.find((tool) => tool.name === "view_signatures")!;
  assert.ok(signatures.inputSchema.properties?.files);
});
