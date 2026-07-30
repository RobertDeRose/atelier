import assert from "node:assert/strict";
import test from "node:test";
import { createStatusView, statusViewText } from "../packages/core/src/presentation/status-view.ts";

test("one typed status view preserves plan, VCS, execution, closure, and next action semantics", () => {
  const status = {
    repositoryRoot: "/repo", workspaceRoot: "/repo", workspaceSource: "startup_cwd", runtimeDirectory: "/state",
    mode: "plan", planPath: "/repo/.atelier/PLAN.md", planExists: true, planStatus: "not_approved",
    currentTaskId: undefined, taskProvider: { provider: "beads", available: true, initialized: true },
    snapshot: { vcs: "jj", workspaceId: "work", changeId: "abcdefghij", headCommit: "123", dirtyGeneration: 2 },
    activePermissions: [], workflowCheckpoint: "reviewed", closureStatus: "not applicable — no active task", nextAction: "Approve.",
  } as any;
  const view = createStatusView(status);
  assert.equal(view.workflow.plan, "not approved");
  assert.equal(view.repository.identity, "jj abcdefgh");
  assert.equal(view.execution.grant, "none");
  assert.match(statusViewText(view), /Task closure: not applicable/);
});
