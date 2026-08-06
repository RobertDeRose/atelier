import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AtelierCore } from "../packages/core/src/core.ts";
import {
  classifyCommitFailure,
  type CommitAttemptState,
} from "../packages/core/src/repository/commit-failure.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

async function activeCore(prefix: string): Promise<{ root: string; core: AtelierCore }> {
  const root = createTemporaryRepository(prefix);
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  core.beginPlan("Persist commit failure decisions");
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  await core.execution.approveAndApply(prepared.approval.id, true);
  return { root, core };
}

test("commit failure classification distinguishes policy failures and bounds evidence", () => {
  const hook = classifyCommitFailure(new Error("pre-commit hook rejected the commit\n" + "secret=".repeat(5_000)));
  assert.equal(hook.category, "hook_rejection");
  assert.equal(hook.retryable, true);
  assert.ok(hook.detail.length <= 4_096);
  assert.match(hook.remediation.join(" "), /without bypassing Git policy/i);

  const signing = classifyCommitFailure(new Error("gpg failed: No secret key"));
  assert.equal(signing.category, "signing_failure");
  assert.equal(signing.retryable, true);

  const filter = classifyCommitFailure(new Error("clean filter process failed"));
  assert.equal(filter.category, "filter_failure");
  assert.equal(filter.retryable, true);

  const timeout = classifyCommitFailure(new Error("pre-commit hook timed out"));
  assert.equal(timeout.category, "timeout");
  assert.equal(timeout.retryable, false);

  const cancelled = classifyCommitFailure(new Error("signing hook cancelled by user"));
  assert.equal(cancelled.category, "user_cancellation");
  assert.equal(cancelled.retryable, false);
});

test("hook rejection persists a bounded retry budget and never weakens Git policy", async () => {
  const { root, core } = await activeCore("atlr-commit-failure-");
  try {
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    const hookPath = join(root, ".git", "hooks", "pre-commit");
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    const hooksPath = spawnSync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(hooksPath.status, 0, hooksPath.stderr);
    writeFileSync(hookPath, "#!/bin/sh\nprintf 'hook rejected\n' >&2\nexit 1\n", "utf8");
    chmodSync(hookPath, 0o755);
    writeFileSync(join(root, "src.ts"), "export const failed = true;\n", "utf8");

    assert.throws(() => core.commitActiveTask("feat: trigger hook failure"), /hook_rejection|hook rejection/i);
    let attempt = core.ledger.getState<CommitAttemptState>(`commitAttempt:${grant.id}`);
    assert.equal(attempt?.category, "hook_rejection");
    assert.equal(attempt?.attempt, 1);
    assert.equal(attempt?.decision, "pending");
    assert.equal(attempt?.remediation.some((item) => /retry/i.test(item)), true);
    assert.equal(attempt?.evidence.length <= 4_096, true);
    assert.ok(attempt?.sourceFingerprint);
    assert.ok(attempt?.configurationFingerprint);
    assert.ok(attempt?.failureFingerprint);
    assert.throws(() => core.commitActiveTask("feat: retry without decision"), /explicit retry|reviewed bypass/i);

    const retryDecision = core.recordCommitFailureDecision("retry");
    assert.equal(retryDecision?.decision, "retry");
    assert.equal(core.ledger.listEvents({ kind: "repository.change_failure_decision" }).length, 1);
    assert.throws(() => core.commitActiveTask("feat: retry hook failure"), /hook_rejection|hook rejection/i);
    attempt = core.ledger.getState<CommitAttemptState>(`commitAttempt:${grant.id}`);
    assert.equal(attempt?.attempt, 2);

    core.recordCommitFailureDecision("retry");
    assert.throws(() => core.commitActiveTask("feat: third hook failure"), /retry budget|attempt budget/i);
    attempt = core.ledger.getState<CommitAttemptState>(`commitAttempt:${grant.id}`);
    assert.equal(attempt?.attempt, 2);
    assert.equal(core.recordCommitFailureDecision("retry", "agent")?.decision, "pending");
    assert.throws(() => core.commitActiveTask("feat: agent cannot loop", "agent"), /explicit retry|reviewed bypass/i);

    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", "utf8");
    core.recordCommitFailureDecision("retry");
    const committed = core.commitActiveTask("feat: commit after external remediation");
    assert.deepEqual(committed.changedPaths, ["src.ts"]);
    assert.equal(core.ledger.getState<CommitAttemptState>(`commitAttempt:${grant.id}`), undefined);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
