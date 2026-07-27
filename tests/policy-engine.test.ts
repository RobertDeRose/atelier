import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PolicyEngine } from "../packages/core/src/policy/policy-engine.ts";
import type { ActionRequest, ExecutionGrant, PermissionGrant } from "../packages/core/src/domain/types.ts";

const repositoryRoot = "/tmp/atlr-policy";
const planPath = resolve(repositoryRoot, ".atelier/PLAN.md");
const policy = new PolicyEngine();

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
  taskId: "task-1",
  planTaskId: "ATLR-001",
  issuedAt: "2026-01-01T00:00:00.000Z",
};

function request(overrides: Partial<ActionRequest>): ActionRequest {
  return {
    action: "write.file",
    risk: "routine",
    actor: "agent",
    rationale: "test",
    ...overrides,
  };
}

test("plan mode allows only the designated plan document", () => {
  const allowed = policy.evaluate(request({ paths: [planPath] }), {
    mode: "plan",
    repositoryRoot,
    planPath,
    grants: [],
  });
  const denied = policy.evaluate(request({ paths: [resolve(repositoryRoot, "src/index.ts")] }), {
    mode: "plan",
    repositoryRoot,
    planPath,
    grants: [],
  });

  assert.equal(allowed.result, "allow");
  assert.equal(denied.result, "deny");
});

test("plan mode blocks task graph mutation even when a grant exists", () => {
  const grant: PermissionGrant = {
    id: "grant-task",
    permission: "task.create",
    scope: "session",
    actor: "user",
    reason: "test",
    createdAt: new Date().toISOString(),
  };
  const decision = policy.evaluate(request({ action: "task.create" }), {
    mode: "plan",
    repositoryRoot,
    planPath,
    grants: [grant],
  });
  assert.equal(decision.result, "deny");
});

test("act-mode agent mutation requires both execution authorization and action permission", () => {
  const sourcePath = resolve(repositoryRoot, "src/index.ts");
  const snapshot = {
    repositoryId: "repository",
    workspaceId: "workspace",
    vcs: "git" as const,
    headCommit: "head",
    dirtyGeneration: 0,
    dirtyFingerprint: "clean",
    indexSchemaVersion: 1,
  };
  const permission: PermissionGrant = {
    id: "grant-file",
    executionGrantId: executionGrant.id,
    permission: "file.write",
    scope: "task",
    actor: "user",
    taskId: executionGrant.taskId,
    repositoryId: executionGrant.repositoryId,
    paths: [resolve(repositoryRoot, "src")],
    reason: "approved implementation",
    createdAt: new Date().toISOString(),
  };
  const action = request({ paths: [sourcePath], taskId: executionGrant.taskId, repositorySnapshot: snapshot });

  assert.equal(policy.evaluate(action, {
    mode: "act", repositoryRoot, planPath, grants: [permission],
  }).result, "require_approval");
  assert.equal(policy.evaluate(action, {
    mode: "act", repositoryRoot, planPath, grants: [], executionGrant,
  }).result, "require_approval");
  assert.equal(policy.evaluate(action, {
    mode: "act", repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "allow");
  assert.equal(policy.evaluate({ ...action, taskId: "other" }, {
    mode: "act", repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
  assert.equal(policy.evaluate({ ...action, repositorySnapshot: { ...snapshot, workspaceId: "other" } }, {
    mode: "act", repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
  const { paths: _paths, ...pathless } = action;
  assert.equal(policy.evaluate(pathless, {
    mode: "act", repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
});

test("act mode still requires approval for destructive, external, and unknown operations", () => {
  for (const risk of ["destructive", "external", "unknown"] as const) {
    const decision = policy.evaluate(request({
      action: risk === "external" ? "network.access" : "command.execute",
      risk,
      command: [risk],
    }), {
      mode: "act",
      repositoryRoot,
      planPath,
      grants: [],
    });
    assert.equal(decision.result, "require_approval", risk);
  }
});

test("an explicit scoped grant can authorize an exceptional operation", () => {
  const sourcePath = resolve(repositoryRoot, "src/index.ts");
  const withTaskGrant = policy.evaluate(request({
    paths: [sourcePath],
    taskId: "task-1",
    risk: "destructive",
    repositorySnapshot: {
      repositoryId: "repository",
      workspaceId: "workspace",
      vcs: "git",
      headCommit: "head",
      dirtyGeneration: 0,
      dirtyFingerprint: "clean",
      indexSchemaVersion: 1,
    },
  }), {
    mode: "act",
    repositoryRoot,
    planPath,
    executionGrant,
    grants: [
      {
        id: "grant-file",
        executionGrantId: executionGrant.id,
        permission: "file.write",
        scope: "task",
        actor: "user",
        taskId: "task-1",
        paths: [resolve(repositoryRoot, "src")],
        reason: "approved implementation",
        createdAt: new Date().toISOString(),
      },
    ],
  });

  assert.equal(withTaskGrant.result, "allow");
});
