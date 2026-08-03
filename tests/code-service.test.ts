import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { AtelierCore, MockCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

class CountingMockCodeProvider extends MockCodeProvider {
  searchCalls = 0;

  override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
    this.searchCalls += 1;
    return super.search(query);
  }
}

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
    await core.close();
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
    await core.close();
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
    await core.close();
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
    const repeated = await core.buildWorkingState();

    assert.equal(provider.searchCalls, 1);
    assert.equal(core.code.retrievalStatus().telemetry.cacheHits, 0);
    assert.ok(
      repeated.retrievalExplanation.some((item) => /resolves every exact identifier|no symbol lookup/i.test(item)),
      "resolved exact identifiers must not trigger another provider request",
    );
  } finally {
    await core.close();
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
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-scoped planning ignores the unreviewed plan scaffold and performs no semantic provider call", async () => {
  const root = createTemporaryRepository("atlr-plan-direct-read-");
  const provider = new CountingMockCodeProvider([]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    core.initialize();
    await provider.ensureIndex(core.codeWorkspace());
    core.beginPlan(
      'Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to packages/core/src/version.ts '
      + "and add tests/version.test.ts verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. "
      + "Do not change release metadata or any other behavior.",
    );

    const state = await core.buildWorkingState();

    assert.equal(
      provider.searchCalls,
      0,
      "the generated but unreviewed plan scaffold must not trigger semantic retrieval",
    );
    assert.deepEqual(state.retrievalQueries, []);
    assert.ok(state.retrievalExplanation.some((item) => /implementation files explicitly/i.test(item)));
    assert.ok(state.retrievalExplanation.some((item) => /Suppressed provider retrieval for 2 known path/i.test(item)));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit symbol lookup normalizes provider signatures, ranks definitions first, and converges inventory", async () => {
  const root = createTemporaryRepository("atlr-symbol-normalization-");
  const provider = new MockCodeProvider([
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root,
      path: "tests/helper.ts",
      symbol: "function openCore(root: string): AtelierCore",
      content: "function openCore(root: string): AtelierCore { throw new Error(root); }",
    },
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root,
      path: "packages/core/src/core.ts",
      symbol: "class AtelierCore",
      content: "export class AtelierCore {}",
    },
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root,
      path: "tests/chunk.ts",
      symbol: "block (12 lines)",
      content: "const typeName = 'AtelierCore';",
    },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    const workspace = core.codeWorkspace();
    await core.code.ensureIndex(workspace);

    const explicit = await core.code.symbols({
      workspace,
      text: "AtelierCore",
      limit: 10,
      requireUnresolved: false,
    });
    assert.equal(explicit[0]?.symbol, "class AtelierCore", "the exact declaration must rank before references");
    assert.equal(explicit[0]?.path, "packages/core/src/core.ts");

    const status = core.code.retrievalStatus();
    assert.ok(status.inventory.resolvedSymbols.includes("AtelierCore"));
    assert.ok(status.inventory.resolvedSymbols.includes("openCore"));
    assert.equal(status.inventory.resolvedSymbols.some((symbol) => /block|lines|class\s/.test(symbol)), false);
    assert.equal(status.inventory.unresolvedSymbols.includes("AtelierCore"), false);
    assert.equal(status.unresolvedSymbolScopes.some((item) => item.symbol === "AtelierCore"), false);

    const workingState = await core.buildWorkingState();
    assert.ok(workingState.retrievalSession?.resolvedSymbols.includes("AtelierCore"));
    assert.equal(
      workingState.retrievalSession?.resolvedSymbols.some((symbol) => /block|lines|class\s/.test(symbol)),
      false,
      "Working State must use canonical identifiers rather than provider display labels",
    );

    const repeated = await core.code.symbols({
      workspace,
      text: "AtelierCore",
      limit: 10,
      requireUnresolved: false,
    });
    assert.equal(repeated[0]?.symbol, "class AtelierCore");
    assert.equal(core.code.retrievalStatus().lastDecision?.kind, "exact_reuse");
    assert.equal(core.code.retrievalStatus().inventory.unresolvedSymbols.includes("AtelierCore"), false);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbol resolution remains repository-scope qualified", async () => {
  const root = createTemporaryRepository("atlr-symbol-scope-");
  const provider = new MockCodeProvider([
    {
      repositoryId: "a",
      repositoryName: "a",
      root,
      path: "src/core.ts",
      symbol: "class AtelierCore",
      content: "export class AtelierCore {}",
    },
    {
      repositoryId: "b",
      repositoryName: "b",
      root,
      path: "src/reference.ts",
      content: "export const typeName = 'AtelierCore';",
    },
  ]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    const snapshot = core.repository.snapshot();
    const workspace = {
      id: "symbol-scope-workspace",
      name: "symbol-scope-workspace",
      roots: [root],
      repositories: [
        { id: "a", name: "a", root, snapshot },
        { id: "b", name: "b", root, snapshot },
      ],
    };
    await core.code.ensureIndex(workspace);
    await core.code.search({ workspace, text: "AtelierCore", repositoryIds: ["b"], literalHints: ["AtelierCore"] });
    await core.code.symbols({ workspace, text: "AtelierCore", repositoryIds: ["a"], requireUnresolved: false });

    const status = core.code.retrievalStatus();
    assert.ok(status.inventory.resolvedSymbols.includes("AtelierCore"));
    assert.ok(status.inventory.unresolvedSymbols.includes("AtelierCore"));
    assert.deepEqual(
      status.unresolvedSymbolScopes.filter((item) => item.symbol === "AtelierCore").map((item) => item.repositoryIds),
      [["b"]],
    );
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbol candidate extraction rejects plan expressions and generic product vocabulary", async () => {
  const root = createTemporaryRepository("atlr-symbol-candidates-");
  const provider = new MockCodeProvider([{
    repositoryId: "repo",
    repositoryName: "repo",
    root,
    path: "src/version.ts",
    content: "export const placeholder = 'ATELIER_PRODUCT_NAME Atelier CLI ATLR';",
  }]);
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: provider });
  try {
    const workspace = core.codeWorkspace();
    await core.code.ensureIndex(workspace);
    await core.code.search({
      workspace,
      text: 'Add `ATELIER_PRODUCT_NAME = "Atelier"` through CLI ATLR',
      literalHints: ['ATELIER_PRODUCT_NAME = "Atelier"', "manual-acceptance"],
    });
    assert.deepEqual(core.code.retrievalStatus().inventory.unresolvedSymbols, ["ATELIER_PRODUCT_NAME"]);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
