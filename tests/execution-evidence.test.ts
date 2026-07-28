import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { AtelierCore } from "../packages/core/src/core.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

async function activeCore(prefix: string): Promise<{ root: string; core: AtelierCore }> {
  const root = createTemporaryRepository(prefix);
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
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

function authorize(core: AtelierCore, request: Parameters<AtelierCore["evaluate"]>[0]): {
  policyDecisionId: string;
  permissionGrantId: string;
} {
  const decision = core.evaluate(request);
  assert.equal(decision.result, "allow");
  const permissionGrantId = decision.matchedRules
    .find((rule) => rule.startsWith("matched permission grant "))
    ?.slice("matched permission grant ".length);
  assert.ok(permissionGrantId);
  return { policyDecisionId: decision.id, permissionGrantId };
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
      policyDecisionId: "invented-decision",
    }), /matching allow policy decision/i);
    core.beginExecutionEvidence({ toolCallId: "success", toolName: "write", request, ...authorize(core, request) });
    writeFileSync(join(root, "src.ts"), "export const changed = true;\n", "utf8");
    const succeeded = core.completeExecutionEvidence("success", { status: "succeeded" });
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

test("focused validation gates closure, becomes stale after mutation, reruns, and survives restart", async () => {
  const { root, core } = await activeCore("atlr-execution-validation-");
  let reopened: AtelierCore | undefined;
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 1;\n", "utf8");
    core.commitActiveTask("feat: add task feature");
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
    core.commitActiveTask("fix: refine task feature");
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
    core.commitActiveTask("feat: add closable task change");
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
