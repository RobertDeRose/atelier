import assert from "node:assert/strict";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AtelierCore, approveWorkspaceRoot } from "../packages/core/src/index.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

test("every approved workspace root receives a real revision snapshot and secondary drift is observable", async () => {
  const primary = createTemporaryRepository("atlr-multi-primary-");
  const secondary = createTemporaryRepository("atlr-multi-secondary-");
  approveWorkspaceRoot(primary, secondary);
  writeFileSync(join(primary, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }), "utf8");
  writeFileSync(join(primary, ".atelier", "workspace.json"), JSON.stringify({
    name: "multi-repository-fixture",
    repositories: [
      { id: "primary", name: "primary", path: primary },
      { id: "secondary", name: "secondary", path: secondary },
    ],
  }), "utf8");

  const core = AtelierCore.open(primary, { taskProvider: "none" });
  try {
    const before = core.codeWorkspace();
    const secondaryBefore = before.repositories.find((repository) => repository.id === "secondary")?.snapshot;
    assert.ok(secondaryBefore);
    assert.notEqual(secondaryBefore.headCommit, "unknown");
    assert.notEqual(secondaryBefore.dirtyFingerprint, "unknown");

    writeFileSync(join(secondary, "secondary-change.ts"), "export const secondaryChange = true;\n", "utf8");
    const after = core.codeWorkspace();
    const secondaryAfter = after.repositories.find((repository) => repository.id === "secondary")?.snapshot;
    assert.ok(secondaryAfter);
    assert.equal(secondaryAfter.repositoryId, secondaryBefore.repositoryId);
    assert.notEqual(secondaryAfter.dirtyFingerprint, secondaryBefore.dirtyFingerprint);
    assert.ok(secondaryAfter.dirtyGeneration > secondaryBefore.dirtyGeneration);
  } finally {
    await core.close();
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});

test("exact approval and execution resume fail closed when a secondary workspace repository drifts", async () => {
  const primary = createTemporaryRepository("atlr-multi-approval-primary-");
  const secondary = createTemporaryRepository("atlr-multi-approval-secondary-");
  approveWorkspaceRoot(primary, secondary);
  writeFileSync(join(primary, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }), "utf8");
  writeFileSync(join(primary, ".atelier", "workspace.json"), JSON.stringify({
    repositories: [
      { id: "primary", path: primary },
      { id: "secondary", path: secondary },
    ],
  }), "utf8");
  writeFileSync(join(primary, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");

  const core = AtelierCore.open(primary, { taskProvider: "memory" });
  const driftPath = join(secondary, "secondary-drift.ts");
  try {
    core.beginPlan("Bind every workspace repository");
    const review = core.beginPlanReview();
    core.completePlanReview(review.id, { exitCode: 0 });
    const prepared = await core.execution.prepare();
    assert.equal(prepared.approval.repositoryBindings.length, 2);

    writeFileSync(driftPath, "export const drift = true;\n", "utf8");
    await assert.rejects(
      core.execution.approveAndApply(prepared.approval.id, true),
      /workspace repository revision changed: secondary/i,
    );

    unlinkSync(driftPath);
    const fresh = await core.execution.prepare();
    const active = await core.execution.approveAndApply(fresh.approval.id, true);
    assert.ok(active.executionGrant);
    assert.equal(active.executionGrant.repositoryBindings.length, 2);

    writeFileSync(driftPath, "export const resumedDrift = true;\n", "utf8");
    assert.equal(await core.execution.resume(), undefined);
    assert.match(
      core.ledger.listExecutionGrants().at(-1)?.invalidationReason ?? "",
      /secondary workspace repository changed/i,
    );
  } finally {
    await core.close();
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});
