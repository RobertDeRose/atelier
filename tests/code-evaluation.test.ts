import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("code evaluation compares baseline, codesearch, and octocode through the same CLI contract", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-code-evaluation-"));
  const bin = join(root, "bin");
  const out = join(root, "out");
  const tasks = join(root, "tasks.json");
  const accepted = join(root, "accepted.json");
  try {
    mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "apps", "cli", "src", "main.ts"), `
const index = process.argv.indexOf("--provider");
const provider = index >= 0 ? process.argv[index + 1] : "codesearch";
const path = provider === "octocode" ? "src/octocode.ts" : "src/codesearch.ts";
process.stdout.write(JSON.stringify({
  results: [{ path, repositoryId: "repo-a", providerRank: 1, provenance: { requestedFilters: { resolvedFocus: "source" }, reranked: false } }],
  retrieval: {
    telemetry: { providerCalls: 1, cacheHits: 2, overlapReuses: 3, uniquePaths: 1, duplicateResultsRemoved: 4, duplicatePathsRemoved: 5, duplicateSymbolsRemoved: 0, duplicateChunksRemoved: 0, duplicateReferencesRemoved: 1, bytesReturned: 99, truncated: true, invalidations: 2 },
    decisions: [{ decision: { kind: "exact_reuse" } }],
    bindings: [{ workspaceId: "workspace", repositories: [{ repositoryId: "repo-a" }] }],
  },
}));
`);
    writeFileSync(join(bin, "rg"), `#!/usr/bin/env bash
printf '%s\\n' '{"type":"match","data":{"path":{"text":"src/baseline.ts"}}}'
`);
    chmodSync(join(bin, "rg"), 0o755);
    writeFileSync(tasks, `${JSON.stringify([{
      id: "provider-comparison",
      query: "Locate provider implementation",
      expectedResults: [
        { path: "src/baseline.ts", relevance: 1 },
        { path: "src/codesearch.ts", relevance: 1 },
        { path: "src/octocode.ts", relevance: 1 },
      ],
      focus: "source",
    }], null, 2)}\n`);
    writeFileSync(accepted, `${JSON.stringify({
      provider: "codesearch",
      tasks: { "provider-comparison": { weightedRecall: 0.3333, expectedFound: ["src/codesearch.ts"] } },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      resolve("scripts/evaluate-code.ts"),
      root,
      tasks,
      out,
      "--providers",
      "codesearch,octocode",
      "--accepted",
      accepted,
    ], {
      cwd: resolve("."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(out, "latest.json"), "utf8")) as {
      providers: string[];
      coldStarts: Record<string, { method?: string }>;
      report: Array<{ providers: Record<string, { method?: string; providerCalls?: number; cacheHits?: number; overlapReuse?: number; duplicateIdentitiesRemoved?: number; bytesReturned?: number; truncation?: boolean; invalidations?: number; repositoryScopes?: string[][] }>; codesearch?: { method?: string }; octocode?: { method?: string } }>;
      aggregate: { baseline?: { tasks?: number }; providers?: Record<string, { tasks?: number; providerCalls?: number; cacheHits?: number; overlapReuse?: number; duplicateIdentitiesRemoved?: number; bytesReturned?: number; truncatedRuns?: number; invalidations?: number }>; codesearch?: { tasks?: number }; octocode?: { tasks?: number } };
    };
    assert.deepEqual(report.providers, ["codesearch", "octocode"]);
    assert.equal(report.coldStarts.codesearch?.method, "codesearch");
    assert.equal(report.coldStarts.octocode?.method, "octocode");
    assert.equal(report.report[0]?.providers.codesearch?.method, "codesearch");
    assert.equal(report.report[0]?.providers.octocode?.method, "octocode");
    assert.equal(report.report[0]?.codesearch?.method, "codesearch");
    assert.equal(report.report[0]?.octocode?.method, "octocode");
    assert.equal(report.report[0]?.providers.codesearch?.providerCalls, 1);
    assert.equal(report.report[0]?.providers.codesearch?.cacheHits, 2);
    assert.equal(report.report[0]?.providers.codesearch?.overlapReuse, 3);
    assert.equal(report.report[0]?.providers.codesearch?.duplicateIdentitiesRemoved, 4);
    assert.equal(report.report[0]?.providers.codesearch?.bytesReturned, 99);
    assert.equal(report.report[0]?.providers.codesearch?.truncation, true);
    assert.equal(report.report[0]?.providers.codesearch?.invalidations, 2);
    assert.deepEqual(report.report[0]?.providers.codesearch?.repositoryScopes, [["repo-a"]]);
    assert.equal(report.aggregate.baseline?.tasks, 1);
    assert.equal(report.aggregate.providers?.codesearch?.tasks, 1);
    assert.equal(report.aggregate.providers?.octocode?.tasks, 1);
    assert.equal(report.aggregate.providers?.codesearch?.providerCalls, 1);
    assert.equal(report.aggregate.providers?.codesearch?.duplicateIdentitiesRemoved, 4);
    assert.equal(report.aggregate.providers?.codesearch?.truncatedRuns, 1);
    assert.equal(report.aggregate.codesearch?.tasks, 1);
    assert.equal(report.aggregate.octocode?.tasks, 1);

    writeFileSync(accepted, `${JSON.stringify({
      provider: "codesearch",
      tasks: {
        "provider-comparison": { weightedRecall: 1, expectedFound: ["src/missing.ts"] },
        "removed-task": { weightedRecall: 1, expectedFound: ["src/removed.ts"] },
      },
    }, null, 2)}\n`);
    const regressed = spawnSync(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      resolve("scripts/evaluate-code.ts"),
      root,
      tasks,
      out,
      "--providers",
      "codesearch",
      "--accepted",
      accepted,
    ], {
      cwd: resolve("."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.notEqual(regressed.status, 0);
    assert.match(regressed.stderr, /accepted codesearch recall regressed.*src\/missing\.ts/is);
    assert.match(regressed.stderr, /removed-task accepted task is missing/is);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
