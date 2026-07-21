import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { InMemoryTaskProvider } from "../packages/core/src/tasks/in-memory-task-provider.ts";
import { PlanReconciler } from "../packages/core/src/planning/plan-reconciler.ts";
import { parsePlanText } from "../packages/core/src/planning/plan-parser.ts";
import { WorkingStateBuilder } from "../packages/core/src/state/working-state-builder.ts";
import type { TaskProvider } from "../packages/core/src/tasks/task-provider.ts";
import type { CreateTaskRequest, TaskPatch, TaskProviderStatus, TaskRecord } from "../packages/core/src/domain/types.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

const snapshot = {
  repositoryId: "repo",
  workspaceId: "workspace",
  vcs: "git" as const,
  headCommit: "HEAD",
  dirtyGeneration: 0,
  dirtyFingerprint: "clean",
  indexSchemaVersion: 1,
};

test("reconciliation is idempotent and Working State advances through ready tasks", async () => {
  const root = createTemporaryRepository("atlr-reconcile-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new InMemoryTaskProvider();
  try {
    const plan = parsePlanText(VALID_PLAN, join(root, ".atelier", "PLAN.md"));
    const reconciler = new PlanReconciler(provider, ledger);
    const preview = await reconciler.preview(plan);
    assert.equal(preview.operations.filter((operation) => operation.kind === "create").length, 2);

    const applied = await reconciler.apply(plan, preview);
    assert.equal(applied.applied, true);
    assert.equal(applied.created.length, 2);

    const secondPreview = await reconciler.preview(plan);
    assert.deepEqual(secondPreview.operations, []);

    const builder = new WorkingStateBuilder(provider, ledger);
    const first = await builder.build({ mode: "act", snapshot, plan });
    assert.equal(first.planTask?.id, "ATLR-001");
    assert.ok(first.activeTask);

    await provider.close(first.activeTask.id, "validated");
    const second = await builder.build({ mode: "act", snapshot, plan });
    assert.equal(second.planTask?.id, "ATLR-002");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class FailingProvider implements TaskProvider {
  readonly name = "failing";
  private failure(): never {
    throw new Error("provider unavailable");
  }
  async status(): Promise<TaskProviderStatus> { return this.failure(); }
  async initialize(): Promise<void> { return this.failure(); }
  async ready(): Promise<TaskRecord[]> { return this.failure(); }
  async get(_taskId: string): Promise<TaskRecord | undefined> { return this.failure(); }
  async list(): Promise<TaskRecord[]> { return this.failure(); }
  async create(_request: CreateTaskRequest): Promise<TaskRecord> { return this.failure(); }
  async update(_taskId: string, _patch: TaskPatch): Promise<TaskRecord> { return this.failure(); }
  async claim(_taskId: string): Promise<TaskRecord> { return this.failure(); }
  async addDependency(_taskId: string, _dependencyTaskId: string): Promise<void> { return this.failure(); }
  async close(_taskId: string, _reason: string): Promise<TaskRecord> { return this.failure(); }
}

test("task provider outages do not break read-only working state construction", async () => {
  const root = createTemporaryRepository("atlr-state-failure-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  try {
    const builder = new WorkingStateBuilder(new FailingProvider(), ledger);
    const state = await builder.build({ mode: "investigate", snapshot });
    assert.equal(state.activeTask, undefined);
    assert.ok(state.omissions.some((message) => message.includes("provider unavailable")));
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
