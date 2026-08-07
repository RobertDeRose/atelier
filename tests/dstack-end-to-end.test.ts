import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { AtelierCore, DisabledCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

function establishQualityGate(root: string): void {
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }), "utf8");
  const staged = spawnSync("git", ["add", "package.json"], { cwd: root, encoding: "utf8", shell: false });
  assert.equal(staged.status, 0, staged.stderr);
  const committed = spawnSync(
    "git",
    ["commit", "--quiet", "--no-gpg-sign", "-m", "test: establish end to end gate baseline"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.equal(committed.status, 0, committed.stderr);
}

test("dstack lifecycle produces bounded context and snapshot-bound gate/closure evidence", async () => {
  const root = createTemporaryRepository("atlr-dstack-end-to-end-");
  establishQualityGate(root);
  writeFileSync(`${root}/.atelier/validation.json`, JSON.stringify({ validations: {}, closurePolicy: { requireValidation: true } }), "utf8");
  writeFileSync(`${root}/.atelier/PLAN.md`, VALID_PLAN, "utf8");
  let core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    core.beginPlan("Prove the first-class dstack lifecycle through closure.");
    const review = core.beginPlanReview();
    core.completePlanReview(review.id, { exitCode: 0 });
    const prepared = await core.execution.prepare();
    assert.equal(prepared.approval.qualityGateMode, "quality-gates");
    assert.equal(prepared.qualityGatePlan?.selectedGateId, "npm:check");
    const started = await core.execution.approveAndApply(prepared.approval.id, true);
    assert.ok(started.executionGrant);
    assert.equal(started.executionGrant.planTaskId, "ATLR-001");

    const gateInventory = await core.qualityGates.discover();
    const capsuleOptions = {
      documentPaths: [".atelier/PLAN.md"],
      gateInventory,
      budgets: { maxBytes: 8_000, maxOutputBytes: 2_000, maxItems: 8, maxHistory: 4, maxRetrieval: 2 },
    } as const;
    const firstCapsule = await core.buildContextCapsule(capsuleOptions);
    const secondCapsule = await core.buildContextCapsule(capsuleOptions);
    assert.equal(secondCapsule.reused, true);
    assert.equal(firstCapsule.digest, secondCapsule.digest);
    assert.ok(firstCapsule.sections.some((section) => section.name === "task"));
    assert.ok(firstCapsule.sections.some((section) => section.name === "documents"));
    assert.ok(firstCapsule.sections.reduce((total, section) => total + section.bytes, 0) <= 8_000);
    assert.ok(Buffer.byteLength(firstCapsule.markdown, "utf8") <= 2_000);

    writeFileSync(`${root}/src.ts`, "export const lifecycle = true;\n", "utf8");
    const committed = await core.commitActiveTask("feat: prove dstack lifecycle");
    assert.deepEqual(committed.changedPaths, ["src.ts"]);
    const diff = core.previewFinalDiff();
    core.reviewFinalDiff(diff.diffHash);
    const closed = await core.closeActiveTask("end to end lifecycle evidence is current");
    assert.equal(closed.task.status, "closed");

    const qualityEvidence = core.ledger.listEvents({ kind: "quality_gate.evidence_recorded", limit: 10 });
    const qualityPayloads = qualityEvidence.map((event) => event.payload as {
      operation?: string;
      passed?: boolean;
      sourceFingerprintBefore?: unknown;
    });
    assert.ok(qualityPayloads.some((payload) => payload.operation === "commit" && payload.passed === true));
    assert.ok(qualityPayloads.some((payload) => payload.operation === "closure" && payload.passed === true));
    assert.ok(qualityPayloads.every((payload) => typeof payload.sourceFingerprintBefore === "string"));
    assert.ok(core.ledger.listEvents({ kind: "repository.change_created" }).length > 0);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
