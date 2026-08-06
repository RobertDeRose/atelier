import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AtelierCore } from "../packages/core/src/core.ts";
import type { WorkspacePolicyDecision } from "../packages/core/src/policy/workspace-policy.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

async function activeCore(prefix: string): Promise<{ root: string; core: AtelierCore }> {
  const root = createTemporaryRepository(prefix);
  writeFileSync(
    join(root, ".atelier", "PLAN.md"),
    VALID_PLAN.replaceAll('"validations":[],"allowFullSuite":false', '"validations":["focused","full"],"allowFullSuite":true'),
    "utf8",
  );
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: {
    focused: {
      command: [process.execPath, "-e", "process.exit(0)"],
      category: "focused",
      focused: true,
      required: true,
      paths: ["src/**"],
    },
    full: {
      command: [process.execPath, "-e", "process.exit(0)"],
      category: "full",
      required: true,
    },
  } }), "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  core.beginPlan("Persist execution evidence");
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  const started = await core.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  return { root, core };
}

function authorize(core: AtelierCore, request: Parameters<AtelierCore["evaluateWorkflow"]>[0]): {
  workflowDecisionId: string;
} {
  const decision = core.evaluateWorkflow(request);
  assert.equal(decision.result, "allow");
  return { workflowDecisionId: decision.id };
}

test("authorized tool attempts record observed success, failure, interruption, and bounded errors", async () => {
  const { root, core } = await activeCore("atlr-execution-evidence-");
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    const request = {
      action: "write.file" as const,
      risk: "routine" as const,
      actor: "agent" as const,
      taskId: grant.taskId,
      repositorySnapshot: core.repository.snapshot(),
      paths: [join(root, "src", "index.ts")],
      rationale: "test mutation",
    };
    assert.throws(() => core.beginExecutionEvidence({
      toolCallId: "unauthorized",
      toolName: "write",
      request,
      workflowDecisionId: "invented-decision",
    }), /matching allow policy decision/i);
    core.beginExecutionEvidence({ toolCallId: "success", toolName: "write", request, ...authorize(core, request) });
    writeFileSync(join(root, "src.ts"), "export const changed = true;\n", "utf8");
    const succeeded = core.completeExecutionEvidence("success", { status: "succeeded" });
    assert.equal(succeeded?.baselineDigest, grant.executionBaseline?.digest);
    assert.equal(succeeded?.observedMutation, true);
    assert.deepEqual(succeeded?.changedPaths, ["src.ts"]);

    request.repositorySnapshot = core.repository.snapshot();
    core.beginExecutionEvidence({ toolCallId: "failure", toolName: "edit", request, ...authorize(core, request) });
    const failed = core.completeExecutionEvidence("failure", { status: "failed", error: "x".repeat(10_000) });
    assert.equal(failed?.observedMutation, false);
    assert.equal(failed?.error?.length, 4_096);

    core.beginExecutionEvidence({ toolCallId: "pending", toolName: "bash", request, ...authorize(core, request) });
    const interrupted = core.interruptPendingExecutionEvidence("session interrupted");
    assert.equal(interrupted[0]?.status, "interrupted");
    assert.equal(core.ledger.listExecutionEvidence({ taskId: grant.taskId }).length, 3);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring a task checkpoint preserves the baseline and requires explicit continuation", async () => {
  const { root, core } = await activeCore("atlr-recovery-task-boundary-");
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant?.executionBaseline);
    mkdirSync(join(root, "src"), { recursive: true });
    const path = join(root, "src", "recoverable.ts");
    writeFileSync(path, "export const state = \"before\";\n", "utf8");
    const decision: WorkspacePolicyDecision = {
      result: "checkpoint_then_allow",
      reason: "test recovery boundary",
      effects: [{
        kind: "overwrite",
        path,
        resolvedPath: path,
        destructive: true,
        state: "tracked_dirty",
        decision: "checkpoint_then_allow",
        reason: "test recovery boundary",
      }],
    };

    const checkpoint = core.checkpointWorkspaceEffects(decision, {
      toolCallId: "recovery-boundary",
      sessionId: "recovery-session",
    });
    assert.equal(checkpoint.baseline?.digest, grant.executionBaseline?.digest);
    writeFileSync(path, "export const state = \"after\";\n", "utf8");

    core.restoreCheckpoint(checkpoint.id);
    assert.equal(readFileSync(path, "utf8"), "export const state = \"before\";\n");
    assert.equal(core.execution.isPaused(), true);
    assert.equal(core.ledger.getExecutionPause()?.checkpointId, checkpoint.id);

    const resumed = await core.execution.resumePaused();
    assert.equal(resumed?.id, grant.id);
    assert.equal(core.execution.isPaused(), false);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure diagnostics distinguish a missing focused selection from a missing validation configuration", async () => {
  const { root, core } = await activeCore("atlr-validation-selection-diagnostic-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = true;\n", "utf8");
    const readiness = core.taskClosureReadiness();
    assert.equal(readiness.ready, false);
    assert.ok(readiness.missing.includes("focused validation selection"));
    assert.match(readiness.reason, /No focused validation selection is recorded/i);
    assert.match(readiness.reason, /focused/);
    assert.doesNotMatch(readiness.reason, /none applies/i);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure diagnostics treat unapproved dirty source as a blocker without throwing", async () => {
  const { root, core } = await activeCore("atlr-closure-scope-diagnostic-");
  try {
    writeFileSync(join(root, "unapproved.ts"), "export const unrelated = true;\n", "utf8");
    assert.doesNotThrow(() => core.taskClosureReadiness());
    const readiness = core.taskClosureReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.blockers.some((blocker) => blocker.code === "local_change_missing"), true);
    assert.match(
      readiness.blockers.find((blocker) => blocker.code === "local_change_missing")?.detail ?? "",
      /reviewed task scope/i,
    );
    const state = await core.buildWorkingState();
    assert.equal(state.taskClosure.ready, false);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused validation gates closure, becomes stale after mutation, reruns, and survives restart", async () => {
  const { root, core } = await activeCore("atlr-execution-validation-");
  let reopened: AtelierCore | undefined;
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 1;\n", "utf8");
    await core.commitActiveTask("feat: add task feature");
    const selection = core.selectFocusedValidation(["Feature"]);
    assert.deepEqual(selection.selected.map((item) => item.name), ["focused"]);
    assert.equal(core.taskClosureReadiness().ready, false);
    assert.match(core.taskClosureReadiness().reason, /missing focused/i);

    const pass = await core.runValidation("focused", { selectionId: selection.id });
    assert.equal(pass.status, "passed");
    await core.runValidation("full");
    core.reviewFinalDiff(core.previewFinalDiff().diffHash);
    assert.equal(core.taskClosureReadiness().ready, true);

    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 2;\n", "utf8");
    assert.equal(core.taskClosureReadiness().ready, false);
    assert.match(core.taskClosureReadiness().reason, /stale focused|diff has not been reviewed|not clean/i);
    await core.commitActiveTask("fix: refine task feature");
    const refreshed = core.selectFocusedValidation(["Feature"]);
    await core.runValidation("focused", { selectionId: refreshed.id });
    await core.runValidation("full");
    core.reviewFinalDiff(core.previewFinalDiff().diffHash);
    assert.equal(core.taskClosureReadiness().ready, true);

    const activeGrant = core.ledger.getActiveExecutionGrant();
    assert.ok(activeGrant);
    const restartRequest = {
        action: "write.file" as const,
        risk: "routine" as const,
        actor: "agent" as const,
        taskId: activeGrant.taskId,
        repositorySnapshot: core.repository.snapshot(),
        paths: [join(root, "src", "feature.ts")],
        rationale: "persist across restart",
      };
    core.beginExecutionEvidence({
      toolCallId: "restart-evidence",
      toolName: "edit",
      request: restartRequest,
      ...authorize(core, restartRequest),
    });
    core.completeExecutionEvidence("restart-evidence", { status: "succeeded" });
    const activeGrantId = activeGrant.id;
    const activeTaskId = activeGrant.taskId;
    const taskProvider = core.taskProvider;
    await core.close();
    reopened = AtelierCore.open(root, { taskProviderInstance: taskProvider, codeProvider: new DisabledCodeProvider() });
    const state = await reopened.buildWorkingState(activeTaskId);
    assert.equal(state.executionGrant?.id, activeGrantId);
    assert.equal(state.workflowCheckpoint, "validating");
    assert.equal(state.planApproval?.id, activeGrant.planApprovalId);
    assert.equal(state.reconciliationTransaction?.id, activeGrant.reconciliationTransactionId);
    assert.equal(state.executionEvidence[0]?.toolCallId, "restart-evidence");
    assert.equal(state.focusedValidationSelections[0]?.id, refreshed.id);
    assert.equal(state.currentValidationEvidence.some((item) => item.name === "focused"), true);
    assert.equal(state.taskClosure.ready, true);
    assert.match(reopened.workingStateBuilder.toMarkdown(state), /Current validation evidence/);
  } finally {
    if (reopened !== undefined) await reopened.close();
    try { await core.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("task closure requires current focused passes, invalidates execution, and exposes but does not start next task", async () => {
  const { root, core } = await activeCore("atlr-execution-close-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "close.ts"), "export const close = true;\n", "utf8");
    const selection = core.selectFocusedValidation();
    await assert.rejects(core.closeActiveTask("not validated"), /missing full|diff has not been reviewed|local commit/i);
    await core.commitActiveTask("feat: add closable task change");
    const currentSelection = core.selectFocusedValidation();
    assert.deepEqual(currentSelection.selected.map((item) => item.name), ["focused"]);
    await core.runValidation("focused", { selectionId: currentSelection.id });
    await core.runValidation("full");
    core.reviewFinalDiff(core.previewFinalDiff().diffHash);
    const result = await core.closeActiveTask("validated explicitly");
    assert.equal(result.task.status, "closed");
    assert.equal(core.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(core.mode(), "plan");
    assert.equal(result.nextReady.length, 1);
    assert.equal(result.nextReady[0]?.planTaskId, "ATLR-002");
    assert.equal(result.nextReady[0]?.status, "open");
    const unrelated = await core.taskProvider.create({
      planTaskId: "UNRELATED-001",
      title: "Unrelated ready work",
      description: "Must never be advertised as approved-plan execution.",
      acceptanceCriteria: [],
      priority: 0,
      type: "task",
    });
    assert.doesNotMatch(await core.nextAction(), new RegExp(unrelated.id));
    const state = await core.buildWorkingState();
    assert.equal(state.executionGrant?.status, "revoked");
    assert.match(state.nextAction, /execute.*approved-plan task/i);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
