import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCodeWorkspace, validateCodeWorkspace } from "../packages/core/src/code/workspace.ts";

const snapshot = { repositoryId: "primary", workspaceId: "ws", vcs: "jj" as const, headCommit: "abc", dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1 };

test("loads explicit multi-repository workspace configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-workspace-"));
  mkdirSync(join(root, ".atelier")); mkdirSync(join(root, "api")); mkdirSync(join(root, "ui"));
  writeFileSync(join(root, ".atelier", "workspace.json"), JSON.stringify({ name: "product", repositories: [{ id: "api", path: "api", role: "backend" }, { id: "ui", path: "ui", tags: ["frontend"] }] }));
  const workspace = loadCodeWorkspace(root, snapshot, {
    rootWithinWorkspace: () => true,
    snapshotForRoot: (repositoryRoot) => ({
      ...snapshot,
      repositoryId: `repository:${repositoryRoot}`,
      workspaceId: `workspace:${repositoryRoot}`,
      headCommit: `head:${repositoryRoot}`,
      dirtyFingerprint: `fingerprint:${repositoryRoot}`,
    }),
  });
  assert.equal(workspace.name, "product"); assert.deepEqual(workspace.repositories.map((r) => r.id), ["api", "ui"]);
  assert.equal(workspace.repositories[0]?.role, "backend"); assert.deepEqual(validateCodeWorkspace(workspace), []);
});
