import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const updater = resolve("scripts/update-codesearch-fixtures.ts");

test("codesearch fixture import fails clearly when no probe artifacts exist", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-empty-probe-"));
  try {
    const probe = join(root, "probe");
    const output = join(root, "fixtures");
    mkdirSync(probe);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", updater, probe, output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No codesearch probe fixtures/);
    assert.match(result.stderr, /collect:codesearch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch fixture import normalizes the probed repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-probe-import-"));
  try {
    const probe = join(root, "probe");
    const output = join(root, "fixtures");
    const repository = join(root, "repository");
    mkdirSync(join(probe, "evaluation"), { recursive: true });
    writeFileSync(join(probe, "search.stdout"), JSON.stringify([{ path: join(repository, "src", "code.ts"), retrievedAt: "2026-07-21T12:00:00Z" }]));
    writeFileSync(join(probe, "evaluation", "latest.json"), JSON.stringify({
      root: repository,
      generatedAt: "2026-07-21T12:00:00Z",
      report: [{ task: { id: "one" }, baseline: { paths: ["src/code.ts"], stdout: "very large raw output", stderr: "diagnostic" }, codesearch: { paths: ["src/code.ts"], stdout: "provider payload", stderr: "" } }],
      summary: [{ id: "one" }],
    }));

    const result = spawnSync(process.execPath, ["--experimental-strip-types", updater, probe, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fixture = readFileSync(join(output, "search.json"), "utf8");
    assert.match(fixture, /<REPOSITORY_ROOT>\/src\/code\.ts/);
    assert.doesNotMatch(fixture, new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as { fixtures?: Record<string, string> };
    assert.equal(manifest.fixtures?.search, "search.json");
    assert.equal(manifest.fixtures?.evaluation, "evaluation.json");
    const evaluation = readFileSync(join(output, "evaluation.json"), "utf8");
    assert.doesNotMatch(evaluation, /very large raw output|provider payload|diagnostic/);
    assert.match(evaluation, /"report"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
