import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AtelierCore,
  DisabledCodeProvider,
  MockCodeProvider,
  createTaskConstraints,
  taskConstraintSummary,
  parsePlanText,
  repositoryRevisionBinding,
  sameRepositoryBindings,
  type WorkflowActionRequest,
  type RepositorySnapshot,
} from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";
import { registerValidationTool } from "../apps/pi-extension/src/validation-tool.ts";

const EXACT_PLAN = `# Exact Manual-Acceptance Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Change only the approved product files
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["src/allowed.ts","tests/allowed.test.ts"],"allowDependencyChanges":false,"validations":["manual-acceptance"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Change one implementation file and its focused test.

### Scope

- src/allowed.ts
- tests/allowed.test.ts

### Out of scope

- Dependency changes
- Full-suite validation
- Any other source file

### Depends on

- None

### Validation

- Run configured validation manual-acceptance

### Completion criteria

- The approved implementation and focused test pass.

### Notes

- Generic shell is not part of this task.
`;

async function exactCore(
  prefix: string,
  codeProvider: DisabledCodeProvider | MockCodeProvider = new DisabledCodeProvider(),
): Promise<{ root: string; core: AtelierCore }> {
  const root = createTemporaryRepository(prefix);
  writeFileSync(join(root, ".atelier", "PLAN.md"), EXACT_PLAN, "utf8");
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({
    validations: {
      "manual-acceptance": {
        command: [process.execPath, "-e", "process.exit(0)"],
        category: "focused",
        focused: true,
        required: true,
        paths: ["src/allowed.ts", "tests/allowed.test.ts"],
      },
      "full-suite": {
        command: [process.execPath, "-e", "process.exit(0)"],
        category: "full",
        required: false,
      },
    },
  }), "utf8");
  const core = AtelierCore.open(root, {
    taskProvider: "memory",
    codeProvider,
  });
  core.beginPlan("Exercise exact task constraints");
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  const started = await core.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  return { root, core };
}

function request(core: AtelierCore, input: Omit<WorkflowActionRequest, "risk" | "actor" | "taskId" | "repositorySnapshot">): WorkflowActionRequest {
  const grant = core.ledger.getActiveExecutionGrant();
  assert.ok(grant);
  return {
    ...input,
    risk: "routine",
    actor: "agent",
    taskId: grant.taskId,
    repositorySnapshot: core.repository.snapshot(),
  };
}

function allow(core: AtelierCore, action: WorkflowActionRequest): { workflowDecisionId: string } {
  const decision = core.evaluateWorkflow(action);
  assert.equal(decision.result, "allow", decision.reason);
  return { workflowDecisionId: decision.id };
}

test("reviewed task metadata produces one narrow task constraint", async () => {
  const { root, core } = await exactCore("atlr-exact-constraints-");
  const canonicalRoot = realpathSync.native(root);
  assert.equal(core.config.repositoryRoot, canonicalRoot);
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    const approval = core.ledger.getPlanApproval(grant.planApprovalId);
    assert.ok(approval);
    const constraints = approval.taskConstraints.filter((item) => item.planTaskId === "ATLR-001");
    assert.equal(constraints.length, 1);
    const constraint = constraints[0]!;
    assert.deepEqual(constraint.focusedValidations, ["manual-acceptance"]);
    assert.equal(constraint.allowDependencyChanges, false);
    assert.equal(constraint.allowFullSuite, false);
    assert.equal(constraint.allowLocalChange, true);
    assert.deepEqual(constraint.writePaths, [
      join(core.config.repositoryRoot, "src", "allowed.ts"),
      join(core.config.repositoryRoot, "tests", "allowed.test.ts"),
    ]);

    const summary = taskConstraintSummary(constraints, core.config.repositoryRoot).join("\n");
    assert.match(summary, /Expected writes: src\/allowed\.ts, tests\/allowed\.test\.ts/);
    assert.match(summary, /Dependency changes: excluded/);
    assert.match(summary, /Focused validations: manual-acceptance/);
    assert.match(summary, /Full suite: excluded/);

    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file", paths: [join(root, "src", "allowed.ts")], rationale: "approved path",
    })).result, "allow");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file", paths: [join(root, "src", "outside.ts")], rationale: "outside reviewed scope",
    })).result, "deny");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "dependency.modify", paths: [join(root, "package.json")], rationale: "dependencies excluded",
    })).result, "deny");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "validation.focused", validationName: "manual-acceptance", rationale: "named focused validation",
    })).result, "allow");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "validation.focused", validationName: "other-check", rationale: "unnamed validation",
    })).result, "deny");

    const closure = core.taskClosureReadiness();
    assert.equal(closure.ready, false);
    assert.ok(closure.blockers.some((item) => item.code === "validation_selection_missing"));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-approval retrieval drift does not revoke source-bound execution control", async () => {
  const provider = new MockCodeProvider([
    {
      repositoryId: "repo",
      repositoryName: "repo",
      root: "",
      path: "src/allowed.ts",
      content: "export const allowed = true;",
      symbol: "allowed",
    },
  ]);
  const { root, core } = await exactCore("atlr-retrieval-control-", provider);
  try {
    const originalGrant = core.ledger.getActiveExecutionGrant();
    assert.ok(originalGrant);

    // Simulate ordinary code-intelligence activity after exact approval. The
    // resulting provider/index binding was not present in the approval record,
    // but the approved source baseline and task constraints are unchanged.
    const workspace = core.codeWorkspace();
    await core.code.ensureIndex(workspace);
    await core.code.search({ workspace, text: "allowed", limit: 10 });
    assert.ok(core.code.retrievalStatus().bindings.length > 0);

    assert.equal((await core.execution.resume())?.id, originalGrant.id);
    assert.equal((await core.execution.resume())?.id, originalGrant.id);
    assert.equal(core.ledger.listEvents({ kind: "execution.retrieval_drift_observed" }).length, 1);

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const before = true;\n", "utf8");
    const implementation = request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "approved implementation after retrieval",
    });
    core.beginExecutionEvidence({
      toolCallId: "retrieval-then-write",
      toolName: "edit",
      request: implementation,
      ...allow(core, implementation),
    });
    writeFileSync(join(root, "src", "allowed.ts"), "export const after = true;\n", "utf8");
    core.completeExecutionEvidence("retrieval-then-write", { status: "succeeded" });

    core.execution.pause("manual retrieval regression pause");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "pause probe",
    })).result, "deny");

    core.execution.resumePaused();
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "resumed edit",
    })).result, "allow");

    const taskId = originalGrant.taskId;
    core.execution.cancel("manual retrieval regression cancellation");
    assert.equal(core.ledger.getActiveExecutionGrant(), undefined);
    assert.equal((await core.taskProvider.get(taskId))?.status, "in_progress");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause, resume, and cancellation are atomic and execution resume is idempotent", async () => {
  const { root, core } = await exactCore("atlr-execution-control-");
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    assert.equal(core.ledger.listEvents({ kind: "execution.resumed" }).length, 0);
    await core.execution.resume();
    await core.execution.resume();
    assert.equal(core.ledger.listEvents({ kind: "execution.resumed" }).length, 0);

    core.execution.pause("manual pause");
    assert.equal(core.execution.isPaused(), true);
    assert.equal(core.ledger.getCurrentWorkflowRun()?.checkpoint, "paused");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "paused mutation",
    })).result, "deny");

    core.execution.resumePaused();
    assert.equal(core.execution.isPaused(), false);
    assert.equal(core.ledger.getCurrentWorkflowRun()?.checkpoint, "executing");
    assert.equal(core.evaluateWorkflow(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "resumed mutation",
    })).result, "allow");

    const taskId = grant.taskId;
    const cancelled = core.execution.cancel("manual cancellation");
    assert.equal(cancelled?.status, "revoked");
    assert.equal(core.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(core.ledger.getCurrentWorkflowRun()?.status, "cancelled");
    assert.equal(core.ledger.getCurrentWorkflowRun()?.checkpoint, "cancelled");
    assert.equal(core.activeTaskConstraints().length, 0);
    assert.equal((await core.taskProvider.get(taskId))?.status, "in_progress");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution evidence attributes only paths changed by the individual operation", async () => {
  const { root, core } = await exactCore("atlr-operation-path-evidence-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const before = true;\n", "utf8");

    const createTest = request(core, {
      action: "write.file",
      paths: [join(root, "tests", "allowed.test.ts")],
      rationale: "create focused test",
    });
    core.beginExecutionEvidence({
      toolCallId: "create-test",
      toolName: "write",
      request: createTest,
      ...allow(core, createTest),
    });
    writeFileSync(join(root, "tests", "allowed.test.ts"), "export const testAdded = true;\n", "utf8");
    const first = core.completeExecutionEvidence("create-test", { status: "succeeded" });
    assert.deepEqual(first?.changedPaths, ["tests/allowed.test.ts"]);
    assert.deepEqual(first?.newlyChangedPaths, ["tests/allowed.test.ts"]);
    assert.deepEqual(first?.unchangedExistingDirtyPaths, ["src/allowed.ts"]);

    const modifyExisting = request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      rationale: "modify existing dirty path",
    });
    core.beginExecutionEvidence({
      toolCallId: "modify-existing",
      toolName: "edit",
      request: modifyExisting,
      ...allow(core, modifyExisting),
    });
    writeFileSync(join(root, "src", "allowed.ts"), "export const after = true;\n", "utf8");
    const second = core.completeExecutionEvidence("modify-existing", { status: "succeeded" });
    assert.deepEqual(second?.changedPaths, ["src/allowed.ts"]);
    assert.deepEqual(second?.furtherModifiedPaths, ["src/allowed.ts"]);
    assert.ok(second?.unchangedExistingDirtyPaths.includes("tests/allowed.test.ts"));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow metadata does not alter source revision bindings or enter a scoped Git commit", async () => {
  const { root, core } = await exactCore("atlr-source-binding-");
  try {
    const before = core.repository.snapshot();
    mkdirSync(join(root, ".beads"), { recursive: true });
    writeFileSync(join(root, ".beads", "manual.log"), "workflow metadata\n", "utf8");
    const afterMetadata = core.repository.snapshot();
    assert.equal(afterMetadata.sourceBaseCommit, before.sourceBaseCommit);
    assert.equal(afterMetadata.sourceFingerprint, before.sourceFingerprint);
    assert.notEqual(afterMetadata.dirtyFingerprint, before.dirtyFingerprint, "raw VCS identity still records workflow metadata drift");
    await core.execution.resume();
    assert.ok(core.ledger.getActiveExecutionGrant());

    const leftSnapshot: RepositorySnapshot = {
      ...before,
      changeId: "old-change",
      operationId: "old-operation",
    };
    const rightSnapshot: RepositorySnapshot = {
      ...before,
      headCommit: "different-working-copy-commit",
      changeId: "new-change",
      operationId: "new-operation",
    };
    assert.equal(
      sameRepositoryBindings(
        [repositoryRevisionBinding("primary", leftSnapshot)],
        [repositoryRevisionBinding("primary", rightSnapshot)],
      ),
      true,
    );

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const scoped = true;\n", "utf8");
    writeFileSync(join(root, ".atelier", "PLAN.md"), `${EXACT_PLAN}\n<!-- reviewed metadata remains outside task commit -->\n`, "utf8");
    execFileSync("git", ["-C", root, "add", ".atelier/PLAN.md"]);
    const result = core.commitActiveTask("test: commit only approved source");
    assert.deepEqual(result.changedPaths, ["src/allowed.ts"]);
    const committed = execFileSync("git", ["-C", root, "show", "--pretty=format:", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n").map((value) => value.trim()).filter(Boolean);
    assert.deepEqual(committed, ["src/allowed.ts"]);
    const metadataStatus = execFileSync("git", ["-C", root, "status", "--short", "--", ".atelier/PLAN.md"], { encoding: "utf8" });
    assert.match(metadataStatus, /^[AMDRC]\s+\.atelier\/PLAN\.md/m, "pre-staged workflow metadata remains outside the task commit");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow metadata does not stale source-qualified validation evidence", async () => {
  const { root, core } = await exactCore("atlr-source-validation-freshness-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const allowed = true;\n", "utf8");
    const selection = core.selectFocusedValidation();
    assert.deepEqual(selection.selected.map((item) => item.name), ["manual-acceptance"]);
    const evidence = await core.runValidation("manual-acceptance", { selectionId: selection.id });
    assert.equal(evidence.status, "passed");
    const taskId = core.ledger.getActiveExecutionGrant()?.taskId;
    assert.ok(taskId);

    mkdirSync(join(root, ".beads"), { recursive: true });
    writeFileSync(join(root, ".beads", "interaction.log"), "provider metadata changed\n", "utf8");
    const afterMetadata = core.validation.list({
      name: "manual-acceptance",
      taskId,
      currentSnapshot: core.currentValidationSnapshot(),
      limit: 1,
    })[0];
    assert.equal(afterMetadata?.stale, false);

    writeFileSync(join(root, "src", "allowed.ts"), "export const allowed = false;\n", "utf8");
    const afterSource = core.validation.list({
      name: "manual-acceptance",
      taskId,
      currentSnapshot: core.currentValidationSnapshot(),
      limit: 1,
    })[0];
    assert.equal(afterSource?.stale, true);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("dependency manifests require an explicit dependency contract and never inherit file.write", () => {
  const root = createTemporaryRepository("atlr-dependency-capabilities-");
  try {
    const excluded = parsePlanText(`# Dependency exclusion\n\n## ATLR-DEP — Exclude dependencies\n<!-- atlr:task {"id":"ATLR-DEP","priority":1,"type":"task","execution":{"writePaths":["package.json"],"allowDependencyChanges":false,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->\n\n### Goal\nNo dependency changes.\n\n### Scope\n- package.json\n\n### Out of scope\n- None\n\n### Depends on\n- None\n\n### Validation\n- Manual\n\n### Completion criteria\n- Complete\n`);
    assert.throws(
      () => createTaskConstraints(excluded.tasks, root),
      /dependency manifests.*allowDependencyChanges is false/i,
    );

    const included = parsePlanText(`# Dependency inclusion\n\n## ATLR-DEP — Include dependency manifest\n<!-- atlr:task {"id":"ATLR-DEP","priority":1,"type":"task","execution":{"writePaths":["package.json"],"allowDependencyChanges":true,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->\n\n### Goal\nUpdate one dependency manifest.\n\n### Scope\n- package.json\n\n### Out of scope\n- None\n\n### Depends on\n- None\n\n### Validation\n- Manual\n\n### Completion criteria\n- Complete\n`);
    const constraints = createTaskConstraints(included.tasks, root);
    assert.equal(constraints.length, 1);
    assert.equal(constraints[0]?.allowDependencyChanges, true);
    assert.deepEqual(constraints[0]?.dependencyPaths, [join(root, "package.json")]);
    assert.deepEqual(constraints[0]?.writePaths, [join(root, "package.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a validation-required workflow cannot approve a task that names no configured required check", () => {
  const root = createTemporaryRepository("atlr-required-validation-contract-");
  try {
    const parsed = parsePlanText(EXACT_PLAN.replace('"validations":["manual-acceptance"]', '"validations":[]'));
    assert.throws(
      () => createTaskConstraints(
        parsed.tasks,
        root,
        [{ name: "manual-acceptance", category: "focused", required: true }],
        { requireValidation: true },
      ),
      /must name at least one configured required validation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("typed model validation reports a failed declared check as a failed tool operation", async () => {
  const { root, core } = await exactCore("atlr-typed-validation-failure-");
  try {
    writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({
      closurePolicy: {
        requireValidation: true,
        requireFinalDiffReview: true,
        requireLocalChange: true,
        requireCleanSource: true,
            requireCleanRepository: true,
      },
      validations: {
        "manual-acceptance": {
          command: [process.execPath, "-e", "process.exit(1)"],
          category: "focused",
          focused: true,
          required: true,
          paths: ["src/allowed.ts"],
        },
      },
    }, null, 2));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const failing = true;\n", "utf8");

    let validationTool: any;
    registerValidationTool({
      registerTool(tool: unknown) { validationTool = tool; },
    } as any, () => core);
    assert.ok(validationTool);
    await assert.rejects(
      validationTool.execute(
        "typed-validation-failure",
        { action: "focused" },
        new AbortController().signal,
        undefined,
        { cwd: root },
      ),
      /Atelier validation failed: Declared validation did not pass:[\s\S]*manual-acceptance: failed/,
    );
    assert.equal(core.validation.list({ currentSnapshot: core.currentValidationSnapshot() }).at(-1)?.status, "failed");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("typed reads allow nonexistent in-root targets but reject nonexistent paths below escaping symlinks", async () => {
  const { root, core } = await exactCore("atlr-nonexistent-read-");
  const outside = `${root}-outside`;
  try {
    mkdirSync(outside, { recursive: true });
    const inRoot = join(root, "tests", "not-created-yet.test.ts");
    const allowed = core.evaluateWorkspaceEffects([{ kind: "read", path: inRoot, description: "read a future in-workspace path" }]);
    assert.equal(allowed.result, "allow", allowed.reason);

    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(root, "escape"), "dir");
    const escaped = core.evaluateWorkspaceEffects([{ kind: "read", path: join(root, "escape", "missing.ts"), description: "read below an escaping symlink" }]);
    assert.equal(escaped.result, "ask");
    assert.equal(escaped.effects[0]?.state, "outside_workspace");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("task closure finalizes workflow metadata and leaves the complete Git repository clean", async () => {
  const { root, core } = await exactCore("atlr-repository-finalization-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, ".beads"), { recursive: true });
    writeFileSync(join(root, "src", "allowed.ts"), "export const accepted = true;\n", "utf8");
    writeFileSync(join(root, "tests", "allowed.test.ts"), "export const tested = true;\n", "utf8");
    writeFileSync(join(root, ".beads", "interactions.jsonl"), "{\"event\":\"active\"}\n", "utf8");

    const selection = core.selectFocusedValidation();
    await core.runValidation("manual-acceptance", { selectionId: selection.id });
    core.commitActiveTask("test: finalize approved source");
    const refreshed = core.selectFocusedValidation();
    await core.runValidation("manual-acceptance", { selectionId: refreshed.id });
    const preview = core.previewFinalDiff();
    core.reviewFinalDiff(preview.diffHash);

    const before = core.taskClosureReadiness();
    assert.equal(before.ready, true, before.reason);
    assert.equal(before.repositoryFinalizationRequired, true);
    assert.ok(before.repositoryMetadataPaths?.includes(".atelier/PLAN.md"));
    assert.ok(before.repositoryMetadataPaths?.includes(".beads/interactions.jsonl"));

    const closeRequest = request(core, {
      action: "task.close",
      rationale: "complete repository finalization",
    });
    const closeAuthorization = allow(core, closeRequest);
    core.beginExecutionEvidence({
      toolCallId: "close-finalization",
      toolName: "atlr_task_close",
      request: closeRequest,
      ...closeAuthorization,
    });

    const closed = await core.closeActiveTask("complete repository finalization", "agent");
    const closeEvidence = core.completeExecutionEvidence("close-finalization", { status: "succeeded" });
    assert.equal(closed.task.status, "closed");
    assert.deepEqual(core.repository.rawChangedPaths(), []);
    assert.equal(core.taskClosureReadiness().ready, true);
    assert.match(core.taskClosureReadiness().reason, /complete.*revoked/i);

    const closedEvent = core.ledger.listEvents({ kind: "task.closed", taskId: closed.task.id, limit: 1 })[0];
    assert.ok(closedEvent);
    const payload = closedEvent.payload as {
      completion: { ready: boolean; stale: string[] };
      finalization: {
        repositoryClean: boolean;
        providerMutationPaths: string[];
        workflowFinalizationPaths: string[];
        sourceFingerprintBefore: string;
        sourceFingerprintAfter: string;
      };
    };
    assert.equal(payload.completion.ready, true, "task.closed must preserve the pre-finalization closure decision");
    assert.deepEqual(payload.completion.stale, []);
    assert.equal(payload.finalization.repositoryClean, true);
    assert.equal(payload.finalization.sourceFingerprintAfter, payload.finalization.sourceFingerprintBefore);
    assert.ok(payload.finalization.workflowFinalizationPaths.includes(".atelier/PLAN.md"));
    assert.ok(payload.finalization.workflowFinalizationPaths.includes(".beads/interactions.jsonl"));

    assert.ok(closeEvidence);
    assert.ok(closeEvidence.changedPaths.includes(".atelier/PLAN.md"));
    assert.ok(closeEvidence.changedPaths.includes(".beads/interactions.jsonl"));
    assert.ok(closeEvidence.workflowFinalizationPaths?.includes(".beads/interactions.jsonl"));

    const validationAfterClosure = core.validation.list({
      name: "manual-acceptance",
      taskId: closed.task.id,
      currentSnapshot: core.currentValidationSnapshot(),
      limit: 1,
    })[0];
    assert.equal(validationAfterClosure?.stale, false, validationAfterClosure?.staleReason);

    const state = await core.buildWorkingState();
    assert.equal(state.taskClosure.ready, true);
    assert.equal(state.staleValidationEvidence.length, 0);
    assert.ok(state.currentValidationEvidence.some((item) => item.name === "manual-acceptance"));

    const metadataCommit = execFileSync("git", ["-C", root, "show", "--pretty=format:", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n").map((value) => value.trim()).filter(Boolean).sort();
    assert.deepEqual(metadataCommit, [".atelier/PLAN.md", ".atelier/config.json", ".atelier/validation.json", ".beads/interactions.jsonl"]);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
