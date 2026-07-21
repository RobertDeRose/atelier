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

test("act mode requires approval until a scoped grant matches", () => {
  const sourcePath = resolve(repositoryRoot, "src/index.ts");
  const withoutGrant = policy.evaluate(request({ paths: [sourcePath] }), {
    mode: "act",
    repositoryRoot,
    planPath,
    grants: [],
  });
  const withGrant = policy.evaluate(request({ paths: [sourcePath] }), {
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
  const withTaskGrant = policy.evaluate(request({ paths: [sourcePath], taskId: "task-1" }), {
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

  assert.equal(withoutGrant.result, "require_approval");
  assert.equal(withGrant.result, "require_approval");
  assert.equal(withTaskGrant.result, "allow");
});
