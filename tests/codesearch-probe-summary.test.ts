import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const commandNames = [
  "version", "help", "mcp_help", "index_help", "search_help", "codesearch_doctor", "codesearch_doctor_after", "codesearch_stats", "codesearch_stats_after", "direct_search", "store_metadata",
  "status_before", "index", "status_after", "mcp_contract", "fetch", "outline", "impact", "semantic", "hybrid", "literal",
  "search", "search_semantic", "search_literal", "status_after_edit", "reindex_after_edit", "search_after_edit", "symbols", "evaluation",
];

test("codesearch probe summary reports a ready conforming provider", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-probe-summary-"));
  try {
    for (const name of commandNames) writeFileSync(join(root, `${name}.status`), "0\n");
    writeFileSync(join(root, "index.stdout"), JSON.stringify({ state: "ready" }));
    writeFileSync(join(root, "codesearch_stats.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ❌ No\n");
    writeFileSync(join(root, "codesearch_stats_after.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ✅ Yes\n");
    writeFileSync(join(root, "search.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_semantic.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_literal.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    for (const name of ["semantic", "hybrid", "literal"]) writeFileSync(join(root, `${name}.stdout`), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\"chunk_id\":1,\"path\":\"src/code.ts\"}]" }] }));
    writeFileSync(join(root, "search_semantic.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_literal.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    for (const name of ["semantic", "hybrid", "literal"]) writeFileSync(join(root, `${name}.stdout`), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\"chunk_id\":1,\"path\":\"src/code.ts\"}]" }] }));
    writeFileSync(join(root, "symbols.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_after_edit.stdout"), JSON.stringify([{ path: ".atelier/probe-staleness.txt" }]));
    writeFileSync(join(root, "fetch.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "source chunk" }] }));
    writeFileSync(join(root, "outline.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\"kind\":\"Class\"}]" }] }));
    writeFileSync(join(root, "impact.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "No symbol indexers installed." }] }));
    writeFileSync(join(root, "mcp_contract.stdout"), JSON.stringify({
      tools: ["status", "search", "find", "get_chunk", "explore", "find_impact"].map((name) => ({ name })),
      statusHistory: [{ state: "building" }, { state: "ready" }],
    }));
    mkdirSync(join(root, "evaluation"), { recursive: true });
    writeFileSync(join(root, "evaluation", "latest.json"), JSON.stringify({ aggregate: { baseline: { meanWeightedRecall: 0.9 }, codesearch: { meanWeightedRecall: 0.8, fusionResultCount: 1, literalHintCount: 3 } } }));

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/summarize-codesearch-probe.ts"),
      root,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(readFileSync(join(root, "conformance.json"), "utf8")) as {
      totals: { failed: number; warnings: number };
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(summary.totals.failed, 0);
    assert.equal(summary.totals.warnings, 1);
    assert.ok(summary.checks.some((check) => check.name === "mcp_index_ready" && check.status === "passed"));
    assert.ok(summary.checks.some((check) => check.name === "fetch_result" && check.status === "passed"));
    assert.ok(summary.checks.some((check) => check.name === "outline_result" && check.status === "passed"));
    assert.ok(summary.checks.some((check) => check.name === "retrieval_hints" && check.status === "passed"));
    assert.ok(summary.checks.some((check) => check.name === "impact_result" && check.status === "warning"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch probe summary treats unavailable optional impact indexing as a warning even when MCP sets isError", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-probe-impact-warning-"));
  try {
    for (const name of commandNames) writeFileSync(join(root, `${name}.status`), "0\n");
    writeFileSync(join(root, "index.stdout"), JSON.stringify({ state: "ready" }));
    writeFileSync(join(root, "codesearch_stats.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ❌ No\n");
    writeFileSync(join(root, "codesearch_stats_after.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ✅ Yes\n");
    writeFileSync(join(root, "search.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_semantic.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_literal.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    for (const name of ["semantic", "hybrid", "literal"]) writeFileSync(join(root, `${name}.stdout`), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\"chunk_id\":1,\"path\":\"src/code.ts\"}]" }] }));
    writeFileSync(join(root, "search_semantic.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_literal.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    for (const name of ["semantic", "hybrid", "literal"]) writeFileSync(join(root, `${name}.stdout`), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\"chunk_id\":1,\"path\":\"src/code.ts\"}]" }] }));
    writeFileSync(join(root, "symbols.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_after_edit.stdout"), JSON.stringify([{ path: ".atelier/probe-staleness.txt" }]));
    writeFileSync(join(root, "fetch.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "source chunk" }] }));
    writeFileSync(join(root, "outline.stdout"), JSON.stringify({ isError: false, structuredContent: { items: [{ kind: "Class" }] } }));
    writeFileSync(join(root, "impact.stdout"), JSON.stringify({ isError: true, content: [{ type: "text", text: "No symbol indexers installed. Install the scip helper." }] }));
    writeFileSync(join(root, "mcp_contract.stdout"), JSON.stringify({
      tools: ["status", "search", "find", "get_chunk", "explore", "find_impact"].map((name) => ({ name })),
      statusHistory: [{ state: "ready" }],
    }));
    mkdirSync(join(root, "evaluation"), { recursive: true });
    writeFileSync(join(root, "evaluation", "latest.json"), JSON.stringify({ aggregate: { baseline: { meanWeightedRecall: 0.9 }, codesearch: { meanWeightedRecall: 0.8 } } }));

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/summarize-codesearch-probe.ts"),
      root,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(readFileSync(join(root, "conformance.json"), "utf8")) as {
      totals: { failed: number; warnings: number };
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(summary.totals.failed, 0);
    assert.ok(summary.checks.some((check) => check.name === "impact_result" && check.status === "warning"));
    assert.ok(summary.checks.some((check) => check.name === "outline_result" && check.status === "passed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch probe summary fails when ignored provider fixtures leak into results", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-probe-fixture-pollution-"));
  try {
    for (const name of commandNames) writeFileSync(join(root, `${name}.status`), "0\n");
    writeFileSync(join(root, "index.stdout"), JSON.stringify({ state: "ready" }));
    writeFileSync(join(root, "codesearch_stats.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ✅ Yes\n");
    writeFileSync(join(root, "codesearch_stats_after.stdout"), "Vector Store:\n   Total chunks: 42\n   Indexed: ✅ Yes\n");
    writeFileSync(join(root, "search.stdout"), JSON.stringify([{ path: "tests/fixtures/codesearch-real/evaluation.json" }]));
    writeFileSync(join(root, "search_semantic.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_literal.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "symbols.stdout"), JSON.stringify([{ path: "src/code.ts" }]));
    writeFileSync(join(root, "search_after_edit.stdout"), JSON.stringify([{ path: ".atelier/probe-staleness.txt" }]));
    for (const name of ["semantic", "hybrid", "literal"]) writeFileSync(join(root, `${name}.stdout`), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\\\"chunk_id\\\":1,\\\"path\\\":\\\"src/code.ts\\\"}]" }] }));
    writeFileSync(join(root, "fetch.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "source chunk" }] }));
    writeFileSync(join(root, "outline.stdout"), JSON.stringify({ isError: false, content: [{ type: "text", text: "[{\\\"kind\\\":\\\"Class\\\"}]" }] }));
    writeFileSync(join(root, "impact.stdout"), JSON.stringify({ isError: true, content: [{ type: "text", text: "No symbol indexers installed." }] }));
    writeFileSync(join(root, "mcp_contract.stdout"), JSON.stringify({
      tools: ["status", "search", "find", "get_chunk", "explore", "find_impact"].map((name) => ({ name })),
      statusHistory: [{ state: "ready" }],
    }));

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/summarize-codesearch-probe.ts"),
      root,
    ], { encoding: "utf8" });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(readFileSync(join(root, "conformance.json"), "utf8")) as {
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    const check = summary.checks.find((item) => item.name === "fixture_pollution");
    assert.equal(check?.status, "failed");
    assert.match(check?.detail ?? "", /tests\/fixtures\/codesearch-real/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
