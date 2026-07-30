import assert from "node:assert/strict";
import test from "node:test";
import { createTemporaryRepository } from "./fixtures.ts";
import { AtelierCore } from "../packages/core/src/core.ts";
import { writeFileSync } from "node:fs";

test("cancelled approved tasks resume without a second provider claim when exact bindings remain current", async () => {
  const root = createTemporaryRepository("atlr-cancel-resume-");
  const core = AtelierCore.open(root);
  try {
    writeFileSync(core.config.planPath, `# Plan\n\n<!-- atlr:plan version="1" -->\n\n## T-1 — Resume\n<!-- atlr:task {"id":"T-1","priority":1,"type":"task","execution":{"writePaths":["src/a.ts"],"allowDependencyChanges":false,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->\n\n### Goal\nResume.\n\n### Scope\n- src/a.ts\n\n### Out of scope\n- None\n\n### Depends on\n- None\n\n### Validation\n- None\n\n### Completion criteria\n- Done\n`, "utf8");
    core.beginPlan("resume");
    const review = core.beginPlanReview({ editor: { executable: "true", args: [], source: "atlr" } });
    core.completePlanReview(review.id, { exitCode: 0 });
    const prepared = await core.execution.prepare();
    const approved = await core.execution.approveAndApply(prepared.approval.id, true);
    const first = approved.executionGrant!;
    core.execution.cancel("operator pause");
    const resumed = await core.execution.resumeCancelledTask(true, approved.task!.id);
    assert.equal(resumed?.task.id, approved.task!.id);
    assert.notEqual(resumed?.executionGrant.id, first.id);
    assert.equal(core.ledger.getActiveExecutionGrant()?.id, resumed?.executionGrant.id);
  } finally { await core.close(); }
});
