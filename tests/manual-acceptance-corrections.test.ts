import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AtelierCore,
  DisabledCodeProvider,
  createExecutionCapabilities,
  executionCapabilitySummary,
  parsePlanText,
  repositoryRevisionBinding,
  sameRepositoryBindings,
  type ActionRequest,
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

async function exactCore(prefix: string): Promise<{ root: string; core: AtelierCore }> {
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
    codeProvider: new DisabledCodeProvider(),
  });
  core.beginPlan("Exercise exact task capabilities");
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  const started = await core.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  return { root, core };
}

function request(core: AtelierCore, input: Omit<ActionRequest, "risk" | "actor" | "taskId" | "repositorySnapshot">): ActionRequest {
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

function allow(core: AtelierCore, action: ActionRequest): { policyDecisionId: string; permissionGrantId: string } {
  const decision = core.evaluate(action);
  assert.equal(decision.result, "allow", decision.reason);
  const permissionGrantId = decision.matchedRules
    .find((rule) => rule.startsWith("matched permission grant "))
    ?.slice("matched permission grant ".length);
  assert.ok(permissionGrantId);
  return { policyDecisionId: decision.id, permissionGrantId };
}

test("reviewed task metadata produces a narrow, named capability bundle", async () => {
  const { root, core } = await exactCore("atlr-exact-capabilities-");
  const canonicalRoot = realpathSync.native(root);
  assert.equal(core.config.repositoryRoot, canonicalRoot);
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    const approval = core.ledger.getPlanApproval(grant.planApprovalId);
    assert.ok(approval);
    const capabilities = approval.capabilities.filter((item) => item.planTaskId === "ATLR-001");
    assert.deepEqual(
      capabilities.map((item) => item.permission).sort(),
      ["file.write", "repository.change.create", "task.close", "validation.focused"],
    );
    assert.equal(capabilities.some((item) => item.permission === "dependency.modify"), false);
    assert.equal(capabilities.some((item) => item.permission === "validation.full_suite"), false);
    assert.deepEqual(
      capabilities.find((item) => item.permission === "validation.focused")?.validationNames,
      ["manual-acceptance"],
    );
    assert.deepEqual(
      capabilities.find((item) => item.permission === "file.write")?.paths,
      [
        join(core.config.repositoryRoot, "src", "allowed.ts"),
        join(core.config.repositoryRoot, "tests", "allowed.test.ts"),
      ],
    );

    const summary = executionCapabilitySummary(capabilities, core.config.repositoryRoot).join("\n");
    assert.match(summary, /Writes: src\/allowed\.ts, tests\/allowed\.test\.ts/);
    assert.match(summary, /Dependencies: not permitted/);
    assert.match(summary, /Focused validations: manual-acceptance/);
    assert.match(summary, /Full suite: not permitted/);

    assert.equal(core.evaluate(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      boundary: "typed",
      rationale: "approved path",
    })).result, "allow");
    assert.equal(core.evaluate(request(core, {
      action: "write.file",
      paths: [join(root, "src", "outside.ts")],
      boundary: "typed",
      rationale: "outside reviewed scope",
    })).result, "require_approval");
    assert.equal(core.evaluate(request(core, {
      action: "dependency.modify",
      paths: [join(root, "package.json")],
      boundary: "typed",
      rationale: "dependencies excluded",
    })).result, "require_approval");
    assert.equal(core.evaluate(request(core, {
      action: "validation.focused",
      validationName: "manual-acceptance",
      boundary: "typed",
      rationale: "named focused validation",
    })).result, "allow");
    assert.equal(core.evaluate(request(core, {
      action: "validation.focused",
      validationName: "other-check",
      boundary: "typed",
      rationale: "unnamed validation",
    })).result, "require_approval");
    assert.equal(core.evaluate(request(core, {
      action: "validation.full_suite",
      validationName: "full-suite",
      boundary: "typed",
      rationale: "full suite excluded",
    })).result, "require_approval");

    const closure = core.taskClosureReadiness();
    assert.equal(closure.ready, false);
    assert.ok(closure.blockers.some((blocker) => blocker.code === "validation_selection_missing"));
    assert.match(closure.reason, /No focused validation selection is recorded/i);
    assert.doesNotMatch(closure.reason, /none applies/i);
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
    assert.equal(core.evaluate(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      boundary: "typed",
      rationale: "paused mutation",
    })).result, "deny");

    core.execution.resumePaused();
    assert.equal(core.execution.isPaused(), false);
    assert.equal(core.ledger.getCurrentWorkflowRun()?.checkpoint, "executing");
    assert.equal(core.evaluate(request(core, {
      action: "write.file",
      paths: [join(root, "src", "allowed.ts")],
      boundary: "typed",
      rationale: "resumed mutation",
    })).result, "allow");

    const taskId = grant.taskId;
    const cancelled = core.execution.cancel("manual cancellation");
    assert.equal(cancelled?.status, "revoked");
    assert.equal(core.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(core.ledger.getCurrentWorkflowRun()?.status, "cancelled");
    assert.equal(core.ledger.getCurrentWorkflowRun()?.checkpoint, "cancelled");
    assert.equal(core.ledger.listGrants().length, 0);
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
      boundary: "typed",
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
      boundary: "typed",
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
      currentSnapshot: core.repository.snapshot(),
      limit: 1,
    })[0];
    assert.equal(afterMetadata?.stale, false);

    writeFileSync(join(root, "src", "allowed.ts"), "export const allowed = false;\n", "utf8");
    const afterSource = core.validation.list({
      name: "manual-acceptance",
      taskId,
      currentSnapshot: core.repository.snapshot(),
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
      () => createExecutionCapabilities(excluded.tasks, root),
      /dependency manifests.*allowDependencyChanges is false/i,
    );

    const included = parsePlanText(`# Dependency inclusion\n\n## ATLR-DEP — Include dependency manifest\n<!-- atlr:task {"id":"ATLR-DEP","priority":1,"type":"task","execution":{"writePaths":["package.json"],"allowDependencyChanges":true,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->\n\n### Goal\nUpdate one dependency manifest.\n\n### Scope\n- package.json\n\n### Out of scope\n- None\n\n### Depends on\n- None\n\n### Validation\n- Manual\n\n### Completion criteria\n- Complete\n`);
    const capabilities = createExecutionCapabilities(included.tasks, root);
    assert.deepEqual(capabilities.map((item) => item.permission).sort(), [
      "dependency.modify",
      "repository.change.create",
      "task.close",
    ]);
    assert.deepEqual(capabilities.find((item) => item.permission === "dependency.modify")?.paths, [join(root, "package.json")]);
    assert.equal(capabilities.some((item) => item.permission === "file.write"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a validation-required workflow cannot approve a task that names no configured required check", () => {
  const root = createTemporaryRepository("atlr-required-validation-contract-");
  try {
    const parsed = parsePlanText(EXACT_PLAN.replace('"validations":["manual-acceptance"]', '"validations":[]'));
    assert.throws(
      () => createExecutionCapabilities(
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
        requireCleanGit: true,
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
    assert.equal(core.validation.list({ currentSnapshot: core.repository.snapshot() }).at(-1)?.status, "failed");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
