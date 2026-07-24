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
  try {
    mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "apps", "cli", "src", "main.ts"), `
const index = process.argv.indexOf("--provider");
const provider = index >= 0 ? process.argv[index + 1] : "codesearch";
const path = provider === "octocode" ? "src/octocode.ts" : "src/codesearch.ts";
process.stdout.write(JSON.stringify([{ path, providerRank: 1, provenance: { requestedFilters: { resolvedFocus: "source" }, reranked: false } }]));
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

    const result = spawnSync(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      resolve("scripts/evaluate-code.ts"),
      root,
      tasks,
      out,
      "--providers",
      "codesearch,octocode",
    ], {
      cwd: resolve("."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(out, "latest.json"), "utf8")) as {
      providers: string[];
      coldStarts: Record<string, { method?: string }>;
      report: Array<{ providers: Record<string, { method?: string }>; codesearch?: { method?: string }; octocode?: { method?: string } }>;
      aggregate: { baseline?: { tasks?: number }; providers?: Record<string, { tasks?: number }>; codesearch?: { tasks?: number }; octocode?: { tasks?: number } };
    };
    assert.deepEqual(report.providers, ["codesearch", "octocode"]);
    assert.equal(report.coldStarts.codesearch?.method, "codesearch");
    assert.equal(report.coldStarts.octocode?.method, "octocode");
    assert.equal(report.report[0]?.providers.codesearch?.method, "codesearch");
    assert.equal(report.report[0]?.providers.octocode?.method, "octocode");
    assert.equal(report.report[0]?.codesearch?.method, "codesearch");
    assert.equal(report.report[0]?.octocode?.method, "octocode");
    assert.equal(report.aggregate.baseline?.tasks, 1);
    assert.equal(report.aggregate.providers?.codesearch?.tasks, 1);
    assert.equal(report.aggregate.providers?.octocode?.tasks, 1);
    assert.equal(report.aggregate.codesearch?.tasks, 1);
    assert.equal(report.aggregate.octocode?.tasks, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
