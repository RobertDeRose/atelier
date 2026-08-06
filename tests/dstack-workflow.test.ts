import assert from "node:assert/strict";
import test from "node:test";
import { AtelierCore } from "../packages/core/src/core.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { InMemoryTaskProvider } from "../packages/core/src/tasks/in-memory-task-provider.ts";
import type { TaskRecord } from "../packages/core/src/domain/types.ts";
import { createTemporaryRepository } from "./fixtures.ts";

function task(input: Partial<TaskRecord> & Pick<TaskRecord, "id" | "title" | "type">): TaskRecord {
  return {
    description: "",
    acceptanceCriteria: [],
    status: "open",
    priority: 1,
    dependencies: [],
    labels: [],
    ...input,
  };
}

function openCore(tasks: TaskRecord[]): { core: AtelierCore; provider: InMemoryTaskProvider } {
  const root = createTemporaryRepository("atlr-dstack-workflow-");
  const provider = new InMemoryTaskProvider(tasks);
  const core = AtelierCore.open(root, {
    taskProvider: "memory",
    taskProviderInstance: provider,
    codeProvider: new DisabledCodeProvider(),
  });
  return { core, provider };
}

test("dstack feature start is explicit and implementation selection preserves Beads authority", async () => {
  const { core, provider } = openCore([
    task({ id: "feature-1", title: "Feature", type: "epic", labels: ["workflow:feature"] }),
    task({ id: "task-1", title: "First task", type: "task", parentId: "feature-1" }),
    task({ id: "task-2", title: "Blocked task", type: "task", parentId: "feature-1", dependencies: ["task-1"] }),
  ]);
  try {
    const before = await core.dstack.inspectFeature("feature-1");
    assert.deepEqual(before.readyTasks.map((item) => item.id), ["task-1"]);
    assert.equal((await core.dstack.startFeature("feature-1", false)), undefined);
    assert.equal((await provider.get("feature-1"))?.status, "open");

    const started = await core.dstack.startFeature("feature-1", true);
    assert.equal(started?.after.feature.status, "in_progress");
    assert.equal(core.ledger.getState("dstack.feature.id"), "feature-1");
    assert.equal(core.ledger.getState("dstack.lifecycle.status"), "active");

    const preparation = await core.dstack.prepareImplementation("feature-1");
    assert.equal(preparation.task.id, "task-1");
    assert.equal(preparation.requiresExplicitExecutionGrant, true);
    assert.equal((await provider.get("task-1"))?.status, "open");

    await provider.close("task-1", "implemented");
    const next = await core.dstack.prepareImplementation("feature-1");
    assert.equal(next.task.id, "task-2");
  } finally {
    await core.close();
  }
});

test("dstack feature transitions reject blockers and require reviewed close evidence", async () => {
  const blocked = openCore([
    task({ id: "blocker", title: "Blocker", type: "task" }),
    task({ id: "feature-2", title: "Blocked feature", type: "epic", labels: ["workflow:feature"], dependencies: ["blocker"] }),
  ]);
  try {
    await assert.rejects(
      blocked.core.dstack.startFeature("feature-2", true),
      /blocked|dependency/i,
    );
    assert.equal((await blocked.provider.get("feature-2"))?.status, "open");
  } finally {
    await blocked.core.close();
  }

  const { core, provider } = openCore([
    task({ id: "feature-3", title: "Closable feature", type: "epic", labels: ["workflow:feature"] }),
    task({ id: "task-3", title: "Completed task", type: "task", parentId: "feature-3", status: "closed" }),
  ]);
  try {
    await core.dstack.startFeature("feature-3", true);
    const review = await core.dstack.beginReview("feature-3", true);
    assert.ok(review);
    assert.equal(review.after.status, "reviewing");
    assert.equal((await core.dstack.closeFeature("feature-3", {
      confirmed: false,
      reason: "not yet",
      reviewComplete: true,
      gatesComplete: true,
    })), undefined);
    assert.equal((await provider.get("feature-3"))?.status, "in_progress");

    const closed = await core.dstack.closeFeature("feature-3", {
      confirmed: true,
      reason: "all implementation work and gates are complete",
      reviewComplete: true,
      gatesComplete: true,
    });
    assert.equal(closed?.after.feature.status, "closed");
    assert.equal(core.ledger.getState("dstack.lifecycle.status"), "completed");
    assert.match(core.ledger.listEvents({ kind: "dstack.feature.closed", limit: 1 })[0]?.kind ?? "", /closed/);
  } finally {
    await core.close();
  }
});

test("dstack pause and recovery preserve explicit user control", async () => {
  const { core, provider } = openCore([
    task({ id: "feature-4", title: "Recoverable feature", type: "epic", labels: ["workflow:feature"] }),
    task({ id: "task-4", title: "Pending task", type: "task", parentId: "feature-4" }),
  ]);
  try {
    await core.dstack.startFeature("feature-4", true);
    const paused = await core.dstack.pauseFeature("feature-4", "user paused before implementation");
    assert.equal(paused?.after.status, "paused");
    assert.equal((await core.dstack.prepareImplementation("feature-4").catch(() => undefined)), undefined);
    assert.equal((await core.dstack.resumeFeature("feature-4", false)), undefined);
    assert.equal((await core.dstack.inspectFeature("feature-4")).status, "paused");

    await core.dstack.markRecoveryRequired("feature-4", "restart requires explicit recovery decision");
    assert.equal((await core.dstack.inspectFeature("feature-4")).status, "recovery_required");
    assert.equal((await core.dstack.resumeFeature("feature-4", true))?.after.status, "active");
    assert.equal((await provider.get("feature-4"))?.status, "in_progress");
  } finally {
    await core.close();
  }
});

test("dstack lifecycle rejects non-feature roots", async () => {
  const { core } = openCore([task({ id: "ordinary-task", title: "Not a feature", type: "task" })]);
  try {
    await assert.rejects(core.dstack.inspectFeature("ordinary-task"), /feature root|epic/i);
  } finally {
    await core.close();
  }
});
