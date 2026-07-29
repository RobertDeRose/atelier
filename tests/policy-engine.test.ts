import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PolicyEngine } from "../packages/core/src/policy/policy-engine.ts";
import type { ActionRequest, ExecutionGrant, PermissionGrant } from "../packages/core/src/domain/types.ts";

const repositoryRoot = mkdtempSync(join(tmpdir(), "atlr-policy-"));
mkdirSync(resolve(repositoryRoot, ".atelier"), { recursive: true });
mkdirSync(resolve(repositoryRoot, "src"), { recursive: true });
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
  repositorySnapshot: {
    repositoryId: "repository",
    workspaceId: "workspace",
    vcs: "git",
    headCommit: "head",
    dirtyGeneration: 0,
    dirtyFingerprint: "clean",
    indexSchemaVersion: 1,
  },
  repositoryBindings: [],
  retrievalBindings: [],
  approvalCapabilityDigest: "approval-capabilities",
  capabilityDigest: "capability-digest",
  taskId: "task-1",
  planTaskId: "ATLR-001",
  issuedAt: "2026-01-01T00:00:00.000Z",
};

function request(overrides: Partial<ActionRequest>): ActionRequest {
  return {
    action: "write.file",
    risk: "routine",
    actor: "agent",
    boundary: "typed",
    rationale: "test",
    ...overrides,
  };
}

test("plan mode allows only the designated plan document", () => {
  const allowed = policy.evaluate(request({ paths: [planPath] }), {
    mode: "plan",
    projectTrusted: true,
    repositoryRoot,
    planPath,
    grants: [],
  });
  const denied = policy.evaluate(request({ paths: [resolve(repositoryRoot, "src/index.ts")] }), {
    mode: "plan",
    projectTrusted: true,
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
    scope: "repository",
    actor: "user",
    reason: "test",
    createdAt: new Date().toISOString(),
  };
  const decision = policy.evaluate(request({ action: "task.create" }), {
    mode: "plan",
    projectTrusted: true,
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
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [permission],
  }).result, "require_approval");
  assert.equal(policy.evaluate(action, {
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [], executionGrant,
  }).result, "require_approval");
  assert.equal(policy.evaluate(action, {
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "allow");
  assert.equal(policy.evaluate({ ...action, taskId: "other" }, {
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
  assert.equal(policy.evaluate({ ...action, repositorySnapshot: { ...snapshot, workspaceId: "other" } }, {
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
  const { paths: _paths, ...pathless } = action;
  assert.equal(policy.evaluate(pathless, {
    mode: "act", projectTrusted: true, repositoryRoot, planPath, grants: [permission], executionGrant,
  }).result, "require_approval");
});

test("focused validation permission never implies full-suite or command permission", () => {
  const snapshot = {
    repositoryId: "repository",
    workspaceId: "workspace",
    vcs: "git" as const,
    headCommit: "head",
    dirtyGeneration: 0,
    dirtyFingerprint: "clean",
    indexSchemaVersion: 1,
  };
  const focusedGrant: PermissionGrant = {
    id: "focused-only",
    executionGrantId: executionGrant.id,
    permission: "validation.focused",
    scope: "task",
    actor: "user",
    taskId: executionGrant.taskId,
    repositoryId: executionGrant.repositoryId,
    reason: "focused only",
    createdAt: new Date().toISOString(),
  };
  const state = { mode: "act" as const, projectTrusted: true, repositoryRoot, planPath, grants: [focusedGrant], executionGrant };
  const base = { actor: "agent" as const, taskId: executionGrant.taskId, repositorySnapshot: snapshot, risk: "routine" as const, rationale: "validate" };
  assert.equal(policy.evaluate({ ...base, action: "validation.focused" }, state).result, "allow");
  assert.equal(policy.evaluate({ ...base, action: "validation.full_suite" }, state).result, "require_approval");
  assert.equal(policy.evaluate({ ...base, action: "command.execute" }, state).result, "require_approval");
});

test("task closure is denied until required focused validation is current and passing", () => {
  const snapshot = {
    repositoryId: "repository", workspaceId: "workspace", vcs: "git" as const,
    headCommit: "head", dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1,
  };
  const closeGrant: PermissionGrant = {
    id: "close", executionGrantId: executionGrant.id, permission: "task.close", scope: "task",
    actor: "user", taskId: executionGrant.taskId, repositoryId: executionGrant.repositoryId,
    reason: "close validated task", createdAt: new Date().toISOString(),
  };
  const action = request({ action: "task.close", taskId: executionGrant.taskId, repositorySnapshot: snapshot });
  const base = { mode: "act" as const, projectTrusted: true, repositoryRoot, planPath, grants: [closeGrant], executionGrant };
  assert.equal(policy.evaluate(action, {
    ...base,
    taskClosure: { ready: false, blockers: [], required: ["focused"], missing: ["focused"], stale: [], failed: [], reason: "missing focused" },
  }).result, "deny");
  assert.equal(policy.evaluate(action, {
    ...base,
    taskClosure: { ready: true, blockers: [], required: ["focused"], missing: [], stale: [], failed: [], reason: "passing" },
  }).result, "allow");
});

test("act mode still requires approval for destructive, external, and unknown operations", () => {
  for (const risk of ["destructive", "external", "unknown"] as const) {
    const decision = policy.evaluate(request({
      action: risk === "external" ? "network.access" : "command.execute",
      risk,
      command: [risk],
    }), {
      mode: "act",
      projectTrusted: true,
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
    projectTrusted: true,
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

test("typed reads identify every externally approved workspace root without broadening mutation scope", () => {
  const secondaryRoot = mkdtempSync(join(tmpdir(), "atlr-policy-secondary-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "atlr-policy-outside-"));
  const base = {
    mode: "plan" as const,
    projectTrusted: true,
    repositoryRoot,
    repositoryReadRoots: [repositoryRoot, secondaryRoot],
    planPath,
    grants: [],
  };
  const secondaryRead = request({
    action: "read.repository",
    actor: "agent",
    paths: [secondaryRoot],
    boundary: "typed",
  });
  const outsideRead = request({
    action: "read.repository",
    actor: "agent",
    paths: [outsideRoot],
    boundary: "typed",
  });
  const secondaryWrite = request({
    action: "write.file",
    actor: "user",
    paths: [secondaryRoot],
    boundary: "typed",
  });

  assert.equal(policy.evaluate(secondaryRead, base).result, "allow");
  assert.equal(policy.evaluate(outsideRead, base).result, "require_approval");
  assert.equal(policy.evaluate(secondaryWrite, { ...base, mode: "act" }).result, "require_approval");
});
