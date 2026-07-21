import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { AtelierCore, MockCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

test("code provider contract supports multi-repository normalized search with provenance", async () => {
  const root = createTemporaryRepository("atlr-code-");
  const provider = new MockCodeProvider([
    { repositoryId: "api", repositoryName: "api", root, path: "src/auth.ts", language: "typescript", symbol: "refreshToken", content: "export function refreshToken() { return 'token'; }" },
    { repositoryId: "ui", repositoryName: "ui", root, path: "src/session.ts", language: "typescript", symbol: "Session", content: "export class Session { refresh() {} }" },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    await core.code.ensureIndex({
      id: "workspace",
      name: "workspace",
      roots: [root],
      repositories: [
        { id: "api", name: "api", root, snapshot: core.repository.snapshot() },
        { id: "ui", name: "ui", root, snapshot: core.repository.snapshot() },
      ],
    });
    const results = await core.code.search({ workspace: core.codeWorkspace(), text: "refresh", limit: 10 });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.provenance.provider.name, "mock");
    assert.equal(results[0]?.provenance.indexState, "ready");
    assert.ok(results.some((result) => result.repositoryId === "api"));
    assert.ok(results.some((result) => result.repositoryId === "ui"));
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Working State consumes normalized provider evidence without owning an index", async () => {
  const root = createTemporaryRepository("atlr-state-code-");
  const provider = new MockCodeProvider([
    { repositoryId: "repo", repositoryName: "repo", root, path: "src/task.ts", language: "typescript", content: "export function durable task state() {}" },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    core.initialize();
    await provider.ensureIndex(core.codeWorkspace());
    const state = await core.buildWorkingState();
    assert.ok(Array.isArray(state.codeEvidence));
    assert.equal("symbolEvidence" in state, false);
    assert.equal("changedSymbols" in state, false);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
