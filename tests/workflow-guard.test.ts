import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkflowGuard } from "../packages/core/src/workflow/workflow-guard.ts";
import type {
  ApprovedTaskConstraint,
  ExecutionGrant,
  WorkflowActionRequest,
} from "../packages/core/src/domain/types.ts";

const workspaceRoot = mkdtempSync(join(tmpdir(), "atlr-workflow-guard-"));
mkdirSync(resolve(workspaceRoot, ".atelier"), { recursive: true });
mkdirSync(resolve(workspaceRoot, "src"), { recursive: true });
const planPath = resolve(workspaceRoot, ".atelier/PLAN.md");
const sourcePath = resolve(workspaceRoot, "src/index.ts");
const guard = new WorkflowGuard();

const snapshot = {
  repositoryId: "repository",
  workspaceId: "workspace",
  vcs: "git" as const,
  headCommit: "head",
  dirtyGeneration: 0,
  dirtyFingerprint: "clean",
  indexSchemaVersion: 1,
};

const executionGrant: ExecutionGrant = {
  id: "execution-1",
  status: "active",
  planApprovalId: "approval-1",
  reconciliationTransactionId: "transaction-1",
  planHash: "plan-hash",
  reconciliationDigest: "reconciliation-digest",
  provider: { name: "memory", version: "1" },
  workspaceId: "workspace",
  repositoryId: "repository",
  repositorySnapshot: snapshot,
  repositoryBindings: [],
  retrievalBindings: [],
  approvalConstraintDigest: "approval-constraints",
  constraintDigest: "task-constraints",
  taskId: "task-1",
  planTaskId: "ATLR-001",
  issuedAt: "2026-01-01T00:00:00.000Z",
};

const taskConstraint: ApprovedTaskConstraint = {
  planTaskId: "ATLR-001",
  writePaths: [sourcePath],
  dependencyPaths: [],
  allowDependencyChanges: false,
  focusedValidations: ["focused"],
  fullValidations: [],
  allowFullSuite: false,
  allowLocalChange: true,
  reason: "reviewed task scope",
};

function request(overrides: Partial<WorkflowActionRequest>): WorkflowActionRequest {
  return {
    action: "write.file",
    risk: "routine",
    actor: "agent",
    rationale: "test",
    ...overrides,
  };
}

function actState() {
  return {
    mode: "act" as const,
    workspaceRoot,
    planPath,
    executionGrant,
    taskConstraints: [taskConstraint],
  };
}

test("plan mode allows only the designated plan document", () => {
  assert.equal(guard.evaluate(request({ paths: [planPath] }), {
    mode: "plan", workspaceRoot, planPath, taskConstraints: [],
  }).result, "allow");
  assert.equal(guard.evaluate(request({ paths: [sourcePath] }), {
    mode: "plan", workspaceRoot, planPath, taskConstraints: [],
  }).result, "deny");
});

test("investigate mode remains read-only", () => {
  assert.equal(guard.evaluate(request({ paths: [sourcePath] }), {
    mode: "investigate", workspaceRoot, planPath, taskConstraints: [],
  }).result, "deny");
  assert.equal(guard.evaluate(request({ action: "read.repository", paths: [sourcePath] }), {
    mode: "investigate", workspaceRoot, planPath, taskConstraints: [],
  }).result, "allow");
});

test("active task mutation is constrained by reviewed task paths without permission grants", () => {
  assert.equal(guard.evaluate(request({ paths: [sourcePath], taskId: executionGrant.taskId }), actState()).result, "allow");
  assert.equal(guard.evaluate(request({ paths: [resolve(workspaceRoot, "other.ts")], taskId: executionGrant.taskId }), actState()).result, "deny");
  assert.equal(guard.evaluate(request({ paths: [sourcePath], taskId: "other" }), actState()).result, "deny");
});

test("reviewed validation and local-change constraints remain independent", () => {
  const state = actState();
  assert.equal(guard.evaluate(request({ action: "validation.focused", validationName: "focused", taskId: executionGrant.taskId }), state).result, "allow");
  assert.equal(guard.evaluate(request({ action: "validation.full_suite", validationName: "full", taskId: executionGrant.taskId }), state).result, "deny");
  assert.equal(guard.evaluate(request({ action: "repository.change.create", paths: [sourcePath], taskId: executionGrant.taskId }), state).result, "allow");
});

test("task closure uses the authoritative completion predicate", () => {
  const requestClose = request({ action: "task.close", taskId: executionGrant.taskId, repositorySnapshot: snapshot });
  assert.equal(guard.evaluate(requestClose, {
    ...actState(),
    taskClosure: { ready: false, blockers: [], required: ["focused"], missing: ["focused"], stale: [], failed: [], reason: "missing focused" },
  }).result, "deny");
  assert.equal(guard.evaluate(requestClose, {
    ...actState(),
    taskClosure: { ready: true, blockers: [], required: ["focused"], missing: [], stale: [], failed: [], reason: "passing" },
  }).result, "allow");
});

test("shell workflow authorization never replaces workspace containment and recoverability", () => {
  const decision = guard.evaluate(request({ action: "command.execute", taskId: executionGrant.taskId }), actState());
  assert.equal(decision.result, "allow");
  assert.match(decision.reason, /workspace containment and recoverability/i);
});
