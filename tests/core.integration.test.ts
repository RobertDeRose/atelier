import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { AtelierCore } from "../packages/core/src/core.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

test("review, approval, reconciliation, and Working State form a runnable vertical slice", async () => {
  const root = createTemporaryRepository("atlr-core-");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    core.initialize();
    writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");

    assert.throws(() => core.approvePlan(), /reviewed/);

    const planText = readFileSync(join(root, ".atelier", "PLAN.md"), "utf8");
    core.beginPlan("Build the guarded core from durable state");
    const review = core.recordPlanReview(planText, planText);
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
