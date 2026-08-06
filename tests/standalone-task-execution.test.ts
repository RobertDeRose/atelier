import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AtelierCore } from "../packages/core/src/core.ts";
import { InMemoryTaskProvider } from "../packages/core/src/tasks/in-memory-task-provider.ts";
import type { TaskRecord } from "../packages/core/src/domain/types.ts";
import { createTemporaryRepository } from "./fixtures.ts";

function realpathForTest(path: string): string {
  return realpathSync(path);
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Implement the existing task",
    description: "Make the bounded source change.",
    acceptanceCriteria: ["The source change is complete."],
    status: "open",
    priority: 1,
    type: "task",
    dependencies: [],
    labels: [],
    ...overrides,
  };
}

test("standalone task activation creates a scoped grant without touching the plan", async () => {
  const root = createTemporaryRepository("atlr-standalone-task-");
  const provider = new InMemoryTaskProvider([task()]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "preexisting.ts"), "export const preexisting = true;\n", "utf8");
  const core = AtelierCore.open(root, { taskProviderInstance: provider });
  try {
    const rejected = await core.execution.startStandaloneTask({
      taskId: "task-1",
    }, false);
    assert.equal(rejected, undefined);
    assert.equal((await provider.get("task-1"))?.status, "open");

    const transition = await core.execution.startStandaloneTask({
      taskId: "task-1",
    }, true);
    assert.ok(transition);

    assert.equal(transition.task.status, "in_progress");
    assert.equal(transition.executionGrant.executionSource, "standalone");
    assert.equal(core.mode(), "act");
    assert.equal(existsSync(core.config.planPath), false);
    assert.equal(core.approvedTaskPaths()[0], realpathForTest(root));
    assert.deepEqual(core.approvedDependencyPaths(), []);
    assert.equal(existsSync(join(root, "src", "preexisting.ts")), true);

    const sourceDecision = core.evaluateWorkflow({
      action: "write.file",
      actor: "agent",
      taskId: "task-1",
      paths: [join(root, "src", "new.ts")],
      rationale: "source change",
    });
    assert.equal(sourceDecision.result, "allow");
    const metadataDecision = core.evaluateWorkflow({
      action: "write.file",
      actor: "agent",
      taskId: "task-1",
      paths: [join(root, ".atelier", "runtime.json")],
      rationale: "metadata change",
    });
    assert.equal(metadataDecision.result, "deny");
    const dependencyDecision = core.evaluateWorkflow({
      action: "dependency.modify",
      actor: "agent",
      taskId: "task-1",
      paths: [join(root, "package.json")],
      rationale: "dependency change",
    });
    assert.equal(dependencyDecision.result, "deny");

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "changed.ts"), "export const changed = true;\n", "utf8");
    assert.equal((await core.execution.resume())?.id, transition.executionGrant.id);
    assert.equal(core.ledger.getActiveExecutionGrant()?.id, transition.executionGrant.id);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone activation does not require legacy validation names", async () => {
  const root = createTemporaryRepository("atlr-standalone-task-quality-gates-");
  writeFileSync(join(root, ".atelier", "validation.json"), `${JSON.stringify({
    closurePolicy: { requireValidation: true },
    validations: { legacy: { command: ["node", "--version"], required: true } },
  })}\n`, "utf8");
  const provider = new InMemoryTaskProvider([task()]);
  const core = AtelierCore.open(root, { taskProviderInstance: provider });
  try {
    const transition = await core.execution.startStandaloneTask({ taskId: "task-1" }, true);
    assert.ok(transition);
    const approval = core.ledger.getPlanApproval(transition.executionGrant.planApprovalId);
    assert.ok(approval);
    assert.match(approval.qualityGateProfileDigest ?? "", /^[a-f0-9]{64}$/);
    assert.ok(approval.qualityGatePlan !== undefined);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone activation rejects epics and stale blockers", async () => {
  const root = createTemporaryRepository("atlr-standalone-task-reject-");
  const provider = new InMemoryTaskProvider([
    task({ id: "epic-1", title: "Feature", type: "epic" }),
    task({ id: "blocked-1", dependencies: ["missing"] }),
  ]);
  const core = AtelierCore.open(root, { taskProviderInstance: provider });
  try {
    await assert.rejects(
      core.execution.startStandaloneTask({ taskId: "epic-1", writePaths: ["src"] }, true),
      /non-executable type epic/i,
    );
    await assert.rejects(
      core.execution.startStandaloneTask({ taskId: "blocked-1", writePaths: ["src"] }, true),
      /not provider-ready/i,
    );
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("working state does not resume an epic as the active implementation task", async () => {
  const root = createTemporaryRepository("atlr-working-state-task-kind-");
  const provider = new InMemoryTaskProvider([
    task({ id: "epic-1", title: "Feature", type: "epic", priority: 0 }),
    task({ id: "task-2", title: "Executable task", priority: 1 }),
  ]);
  const core = AtelierCore.open(root, { taskProviderInstance: provider });
  core.ledger.setState("currentTaskId", "epic-1");
  try {
    const state = await core.buildWorkingState();
    assert.equal(state.activeTask?.id, "task-2");
    assert.equal(state.activeTask?.type, "task");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
