import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Octocode conformance accepts required tools and warns when GraphRAG is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-conformance-"));
  try {
    for (const name of ["setup_config", "version", "help", "mcp_help", "config_show", "stats_before", "embedding_environment", "index", "stats_after", "adapter_index", "providers", "status", "search", "symbols", "mcp_contract", "related"]) {
      writeFileSync(join(root, `${name}.status`), "0\n");
    }
    writeFileSync(join(root, "setup_config.stdout"), JSON.stringify({ configPath: "/tmp/repo/.atelier/octocode-config.toml", codeModel: "fastembed:jinaai/jina-embeddings-v2-base-code", textModel: "fastembed:nomic-ai/nomic-embed-text-v1.5", graphRagEnabled: true }));
    writeFileSync(join(root, "embedding_environment.stdout"), JSON.stringify({ configured: true, guidance: "Embedding provider prerequisites are available." }));
    writeFileSync(join(root, "search.stdout"), JSON.stringify([{ path: "packages/core/src/core.ts" }]));
    writeFileSync(join(root, "symbols.stdout"), JSON.stringify([{ path: "packages/core/src/code/octocode-provider.ts" }]));
    writeFileSync(join(root, "related.stdout"), JSON.stringify({ skipped: true, reason: "graphrag was not advertised" }));
    writeFileSync(join(root, "mcp_contract.stdout"), JSON.stringify({
      tools: [
        { name: "semantic_search" },
        { name: "structural_search" },
        { name: "view_signatures" },
      ],
      calls: {
        semantic_search: { isError: false },
        structural_search: { isError: false },
        view_signatures: { isError: false },
        graphrag: { skipped: true, reason: "not advertised" },
      },
    }));
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", resolve("scripts/summarize-octocode-probe.ts"), root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, "conformance.json"), "utf8")) as { totals: { failed: number; warnings: number } };
    assert.equal(report.totals.failed, 0);
    assert.ok(report.totals.warnings >= 1);
    assert.match(readFileSync(join(root, "CONFORMANCE.md"), "utf8"), /relationships remain unsupported|graphrag was not advertised/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
