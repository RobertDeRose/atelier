import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { AtelierCore, MockCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

class DeferredIndexProvider extends MockCodeProvider {
  indexCalls = 0;
  searchCalls = 0;
  private releaseIndex!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.releaseIndex = resolve; });

  release(): void { this.releaseIndex(); }

  override async ensureIndex(workspace: Parameters<MockCodeProvider["ensureIndex"]>[0]) {
    this.indexCalls += 1;
    await this.gate;
    return super.ensureIndex(workspace);
  }

  override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
    this.searchCalls += 1;
    return super.search(query);
  }
}

test("code indexing coordinator coalesces requests and makes search wait for the active writer", async () => {
  const root = createTemporaryRepository("atlr-code-coordinator-");
  const provider = new DeferredIndexProvider([
    { repositoryId: "repo", repositoryName: "repo", root, path: "src/index.ts", content: "export const coordinated = true;" },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    const workspace = core.codeWorkspace();
    const statuses: string[] = [];
    const unsubscribe = core.code.onIndexStatus((status) => statuses.push(`${status.state}:${status.active}`));
    const first = core.code.ensureIndex(workspace);
    const second = core.code.ensureIndex(workspace);
    const search = core.code.search({ workspace, text: "coordinated", limit: 10 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.indexCalls, 1);
    assert.equal(provider.searchCalls, 0);
    assert.equal(core.code.indexingStatus().state, "building");
    assert.equal((await core.code.status(undefined, workspace)).indexState, "building");

    provider.release();
    assert.equal(await first, "ready");
    assert.equal(await second, "ready");
    assert.equal((await search).length, 1);
    assert.equal(provider.searchCalls, 1);
    assert.equal(core.code.indexingStatus().state, "ready");
    assert.deepEqual(statuses, ["unknown:false", "building:true", "ready:false"]);
    unsubscribe();
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("code provider contract supports multi-repository normalized search with provenance", async () => {
  const root = createTemporaryRepository("atlr-code-");
  const provider = new MockCodeProvider([
    { repositoryId: "api", repositoryName: "api", root, path: "src/auth.ts", language: "typescript", symbol: "refreshToken", content: "export function refreshToken() { return 'token'; }" },
    { repositoryId: "ui", repositoryName: "ui", root, path: "src/session.ts", language: "typescript", symbol: "Session", content: "export class Session { refresh() {} }" },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    const workspace = {
      id: "workspace",
      name: "workspace",
      roots: [root],
      repositories: [
        { id: "api", name: "api", root, snapshot: core.repository.snapshot() },
        { id: "ui", name: "ui", root, snapshot: core.repository.snapshot() },
      ],
    };
    await core.code.ensureIndex(workspace);
    const results = await core.code.search({ workspace, text: "refresh", limit: 10 });
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

test("repeated Working State builds reuse one provider request at the same revisions", async () => {
  const root = createTemporaryRepository("atlr-state-reuse-");
  const provider = new DeferredIndexProvider([
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root,
      path: "packages/core/src/code/service.ts",
      symbol: "CodeService",
      content: "export class CodeService { retrievalSession = true; }",
    },
  ]);
  provider.release();
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    core.initialize();
    await core.code.ensureIndex(core.codeWorkspace());
    core.beginPlan("Update `CodeService` retrieval sessions");

    await core.buildWorkingState();
    await core.buildWorkingState();

    assert.equal(provider.searchCalls, 1);
    assert.equal(core.code.retrievalStatus().telemetry.cacheHits, 1);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning mode retrieves code from the durable objective before a task exists", async () => {
  const root = createTemporaryRepository("atlr-plan-code-");
  const provider = new MockCodeProvider([
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root,
      path: "packages/core/src/state/working-state-builder.ts",
      language: "typescript",
      symbol: "WorkingStateBuilder",
      content: "export class WorkingStateBuilder { build() { return durablePlanningObjective; } }",
    },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    core.initialize();
    await provider.ensureIndex(core.codeWorkspace());
    core.beginPlan("Update `WorkingStateBuilder` to use durablePlanningObjective");

    const state = await core.buildWorkingState();

    assert.equal(state.mode, "plan");
    assert.equal(state.planObjective, "Update `WorkingStateBuilder` to use durablePlanningObjective");
    assert.equal(state.activeTask, undefined);
    assert.equal(state.retrievalQueries[0]?.purpose, "plan_objective");
    assert.equal(state.codeEvidence[0]?.queryPurpose, "plan_objective");
    assert.equal(state.codeEvidence[0]?.path, "packages/core/src/state/working-state-builder.ts");
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
