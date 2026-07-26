import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { AtelierCore } from "../packages/core/src/core.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

test("plan review resumes across a Core restart", () => {
  const root = createTemporaryRepository("atlr-core-review-restart-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");

  let core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    core.beginPlan("Resume a durable plan review");
    const started = core.beginPlanReview({
      editor: { executable: "fake-editor", args: [], source: "atlr" },
    });
    core.close();

    core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
    assert.equal(core.currentWorkflowRun()?.checkpoint, "reviewing");
    assert.equal(core.ledger.getManualEdit(started.id)?.status, "started");

    writeFileSync(planPath, VALID_PLAN.replace("Create the guarded core.", "Create the restart-safe guarded core."), "utf8");
    const completed = core.completePlanReview(started.id, { exitCode: 0 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.accepted, true);
    assert.equal(core.currentWorkflowRun()?.checkpoint, "reviewed");
    assert.equal(core.ledger.getState("reviewedPlanHash"), completed.afterHash);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review, approval, reconciliation, and Working State form a runnable vertical slice", async () => {
  const root = createTemporaryRepository("atlr-core-");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    core.initialize();
    writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");

    assert.throws(() => core.approvePlan(), /reviewed/);

    core.beginPlan("Build the guarded core from durable state");
    const started = core.beginPlanReview();
    const review = core.completePlanReview(started.id, { exitCode: 0 });
    assert.equal(review.changed, false);
    const approvedHash = core.approvePlan();

    const preview = await core.reconcilePlan(false);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.operations.filter((operation) => operation.kind === "create").length, 2);

    const applied = await core.reconcilePlan(true);
    assert.equal(applied.applied, true);

    core.setMode("act");
    const state = await core.buildWorkingState();
    assert.equal(state.approvedPlanHash, approvedHash);
    assert.equal(state.planObjective, "Build the guarded core from durable state");
    assert.equal(state.planTask?.id, "ATLR-001");
    assert.equal(state.activeTask?.status, "open");

    const status = await core.status();
    assert.equal(status.mode, "act");
    assert.equal(status.planObjective, "Build the guarded core from durable state");
    assert.equal(status.taskProvider.provider, "memory");
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
