import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { AtelierCore, DisabledCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

function commitPackage(root: string, scripts: Record<string, string>): void {
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts }), "utf8");
  const staged = spawnSync("git", ["add", "package.json"], { cwd: root, encoding: "utf8", shell: false });
  assert.equal(staged.status, 0, staged.stderr);
  const committed = spawnSync(
    "git",
    ["commit", "--quiet", "--no-gpg-sign", "-m", "test: establish migration gate baseline"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.equal(committed.status, 0, committed.stderr);
}

async function approvePlan(core: AtelierCore, objective: string): Promise<void> {
  core.beginPlan(objective);
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  await core.execution.approveAndApply(prepared.approval.id, true);
}

test("quality-gate migration preserves legacy evidence and mode across restart", async () => {
  const root = createTemporaryRepository("atlr-dstack-migration-quality-");
  commitPackage(root, { check: "node -e \"process.exit(0)\"" });
  writeFileSync(`${root}/.atelier/validation.json`, JSON.stringify({
    closurePolicy: { requireValidation: true },
    validations: {
      legacy: { command: [process.execPath, "-e", "process.exit(0)"], category: "focused", focused: true, required: true },
    },
  }), "utf8");
  let core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    const legacyEvidence = await core.runValidation("legacy");
    assert.equal(legacyEvidence.status, "passed");
    await approvePlan(core, "Migrate an existing project to repository quality gates.");
    const approval = core.ledger.getActiveExecutionGrant();
    assert.ok(approval);
    const planApproval = core.ledger.getPlanApproval(approval.planApprovalId);
    assert.equal(planApproval?.qualityGateMode, "quality-gates");
    assert.equal(core.validationEvidenceIsHistorical(), true);

    const beforeRestart = await core.buildWorkingState();
    assert.equal(beforeRestart.validationEvidence[0]?.historical, true);
    await core.close();
    core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });

    assert.equal(core.validationEvidenceIsHistorical(), true);
    const afterRestart = await core.buildWorkingState();
    assert.equal(afterRestart.planApproval?.qualityGateMode, "quality-gates");
    assert.equal(afterRestart.reconciliationTransaction?.qualityGateMode, "quality-gates");
    assert.equal(afterRestart.validationEvidence[0]?.historical, true);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy execution remains readable when no repository quality gate is available", async () => {
  const root = createTemporaryRepository("atlr-dstack-migration-legacy-");
  const legacyPlan = VALID_PLAN.replaceAll('"validations":[]', '"validations":["legacy"]');
  writeFileSync(`${root}/.atelier/PLAN.md`, legacyPlan, "utf8");
  writeFileSync(`${root}/.atelier/validation.json`, JSON.stringify({
    closurePolicy: { requireValidation: true },
    validations: {
      legacy: { command: [process.execPath, "-e", "process.exit(0)"], category: "focused", focused: true, required: true },
    },
  }), "utf8");
  let core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    await approvePlan(core, "Preserve a legacy validation contract when no repository gate exists.");
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    const approval = core.ledger.getPlanApproval(grant.planApprovalId);
    assert.equal(approval?.qualityGateMode, "legacy");
    assert.equal(core.validationEvidenceIsHistorical(), false);
    const selection = core.selectFocusedValidation();
    const evidence = await core.runValidation("legacy", { selectionId: selection.id });
    assert.equal(evidence.historical, undefined);
    await core.close();
    core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });

    assert.equal(core.validationEvidenceIsHistorical(), false);
    const afterRestart = await core.buildWorkingState();
    assert.equal(afterRestart.planApproval?.qualityGateMode, "legacy");
    assert.equal(afterRestart.currentValidationEvidence[0]?.historical, undefined);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
