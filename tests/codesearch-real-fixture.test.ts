import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/codesearch-real/${name}.json`, "utf8")) as T;
}

test("real codesearch 1.1.30 fixtures preserve the verified MCP contract", () => {
  const status = fixture<{
    status?: { identity?: { version?: string }; indexState?: string; capabilities?: string[]; detail?: string };
  }>("status_after");
  assert.equal(status.status?.identity?.version, "1.1.30");
  assert.equal(status.status?.indexState, "ready");
  assert.ok(status.status?.capabilities?.includes("result.fetch_on_demand"));
  assert.ok(status.status?.capabilities?.includes("graph.impact"));
  assert.ok(status.status?.capabilities?.includes("file.outline"));
  assert.match(status.status?.detail ?? "", /Mode: self-contained/);

  const contract = fixture<{ tools?: Array<{ name?: string; inputSchema?: unknown }> }>("mcp_contract");
  const names = contract.tools?.map((tool) => tool.name) ?? [];
  for (const expected of ["status", "search", "find", "get_chunk", "explore", "find_impact"]) {
    assert.ok(names.includes(expected), `missing MCP tool fixture: ${expected}`);
  }
  assert.ok(contract.tools?.every((tool) => tool.inputSchema !== undefined));

  const search = fixture<Array<{ path?: string; reference?: { opaqueId?: string } }>>("search");
  assert.ok(search.length > 0);
  assert.match(search[0]?.path ?? "", /^<REPOSITORY_ROOT>\//);
  assert.ok(search[0]?.reference?.opaqueId);

  const fetch = fixture<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>("fetch");
  assert.equal(fetch.isError, false);
  assert.match(fetch.content?.[0]?.text ?? "", /ADR-0002-EXTERNAL-CODE-PROVIDERS/);

  const outline = fixture<{ content?: Array<{ text?: string }> }>("outline");
  assert.match(outline.content?.[0]?.text ?? "", /CodesearchProvider/);

  const impact = fixture<{ content?: Array<{ text?: string }>; isError?: boolean }>("impact");
  assert.equal(impact.isError, false);
  assert.match(impact.content?.[0]?.text ?? "", /No symbol indexers installed/);


  const evaluation = fixture<{ summary?: unknown[]; report?: unknown[] }>("evaluation");
  assert.equal(evaluation.summary?.length, 4);
  assert.equal(evaluation.report?.length, 4);

  const conformance = fixture<{ totals?: { failed?: number; warnings?: number; passed?: number } }>("conformance");
  assert.equal(conformance.totals?.failed, 0);
  assert.equal(conformance.totals?.warnings, 0);
  assert.ok((conformance.totals?.passed ?? 0) >= 23);

  const serialized = JSON.stringify({ status, contract, search, fetch, outline, impact, evaluation, conformance });
  assert.doesNotMatch(serialized, /DeRoseR/);
  assert.doesNotMatch(serialized, /\/Users\/(?!<USER>)/);
});
