import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PolicyEngine } from "../packages/core/src/policy/policy-engine.ts";
import type { ActionRequest, PermissionGrant } from "../packages/core/src/domain/types.ts";

const repositoryRoot = "/tmp/atlr-policy";
const planPath = resolve(repositoryRoot, ".atelier/PLAN.md");
const policy = new PolicyEngine();

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

test("act mode allows routine in-repository changes without grants", () => {
  const sourcePath = resolve(repositoryRoot, "src/index.ts");
  const routine = policy.evaluate(request({ paths: [sourcePath] }), {
    mode: "act",
    repositoryRoot,
    planPath,
    grants: [],
  });
  const outside = policy.evaluate(request({ paths: ["/tmp/outside.ts"] }), {
    mode: "act",
    repositoryRoot,
    planPath,
    grants: [],
  });

  assert.equal(routine.result, "allow");
  assert.equal(outside.result, "require_approval");
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
  const withTaskGrant = policy.evaluate(request({ paths: [sourcePath], taskId: "task-1", risk: "destructive" }), {
    mode: "act",
    repositoryRoot,
    planPath,
    grants: [
      {
        id: "grant-file",
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
