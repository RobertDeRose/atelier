import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AtelierCore, loadConfig } from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

const expectedDefaults = {
  codeMaxProviderRequests: 8,
  codeMaxUniquePaths: 32,
  codeMaxEvidenceEntries: 64,
  codeRetainedSessions: 4,
  codeMaxPersistedEntries: 256,
  codeMaxPersistedBytes: 256_000,
};

test("retrieval budgets have bounded defaults and repository overrides", () => {
  const root = createTemporaryRepository("atlr-retrieval-config-");
  try {
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedDefaults).map((key) => [key, loadConfig(root)[key as keyof ReturnType<typeof loadConfig>]])),
      expectedDefaults,
    );
    const path = join(root, ".atelier", "config.json");
    const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({
      ...existing,
      codeMaxProviderRequests: 3,
      codeMaxUniquePaths: 4,
      codeMaxEvidenceEntries: 5,
      codeRetainedSessions: 2,
      codeMaxPersistedEntries: 10,
      codeMaxPersistedBytes: 80_000,
    })}\n`, "utf8");
    const overridden = loadConfig(root);
    assert.equal(overridden.codeMaxProviderRequests, 3);
    assert.equal(overridden.codeMaxPersistedEntries, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configuration validation rejects non-positive and impossible retrieval budgets", () => {
  const root = createTemporaryRepository("atlr-retrieval-config-invalid-");
  const path = join(root, ".atelier", "config.json");
  const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({
    ...existing,
    codeMaxProviderRequests: 0,
    codeMaxUniquePaths: 8,
    codeMaxEvidenceEntries: 4,
    codeRetainedSessions: -1,
    codeMaxPersistedEntries: 2,
    codeMaxPersistedBytes: 10,
  })}\n`, "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  try {
    const issues = core.validateConfiguration();
    assert.ok(issues.some((issue) => issue.includes("codeMaxProviderRequests must be a positive integer")));
    assert.ok(issues.some((issue) => issue.includes("codeMaxUniquePaths must be <= codeMaxEvidenceEntries")));
    assert.ok(issues.some((issue) => issue.includes("codeMaxEvidenceEntries must be <= codeMaxPersistedEntries")));
    assert.ok(issues.some((issue) => issue.includes("codeMaxPersistedEntries must cover")));
    assert.ok(issues.some((issue) => issue.includes("codeMaxPersistedBytes must be >= codeMaxTotalBytes")));
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI configuration output reports effective retrieval budgets", () => {
  const root = createTemporaryRepository("atlr-retrieval-config-cli-");
  try {
    const result = spawnSync(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      join(process.cwd(), "apps", "cli", "src", "main.ts"),
      "--root", root, "config", "validate", "--json",
    ], { encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { retrievalBudgets: Record<string, number> };
    assert.deepEqual(output.retrievalBudgets, {
      providerRequests: 8,
      results: 10,
      uniquePaths: 32,
      compactEntries: 64,
      retainedSessions: 4,
      persistedEntries: 256,
      persistedBytes: 256_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization writes retrieval budgets to the repository configuration", () => {
  const root = createTemporaryRepository("atlr-retrieval-config-init-");
  rmSync(join(root, ".atelier", "config.json"), { force: true });
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  try {
    core.initialize({ createPlan: false });
    const initialized = JSON.parse(readFileSync(join(root, ".atelier", "config.json"), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expectedDefaults)) assert.equal(initialized[key], value);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
