import assert from "node:assert/strict";
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { AtelierCore } from "../packages/core/src/core.ts";
import type { WorkflowRun } from "../packages/core/src/domain/types.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { loadDatabaseSync } from "../packages/core/src/ledger/sqlite-runtime.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

function openCore(root: string): AtelierCore {
  return AtelierCore.open(root, {
    taskProvider: "memory",
    codeProvider: new DisabledCodeProvider(),
  });
}

function editor() {
  return { executable: "fake-editor", args: ["--wait"], source: "atlr" as const };
}

test("an unchanged plan review is durable completed ManualEdit evidence", () => {
  const root = createTemporaryRepository("atlr-plan-review-unchanged-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Review an unchanged plan");
    const started = core.beginPlanReview({ editor: editor() });
    const completed = core.completePlanReview(started.id, { exitCode: 0 });

    assert.equal(completed.status, "completed");
    assert.equal(completed.changed, false);
    assert.equal(completed.ambiguous, false);
    assert.deepEqual(completed.editor, editor());
    assert.equal(completed.beforeRepositorySnapshot.repositoryId, completed.afterRepositorySnapshot?.repositoryId);
    assert.deepEqual(completed.changedPaths, []);
    assert.deepEqual(completed.structuralDiff, {
      added: [],
      removed: [],
      reordered: [],
      changed: [],
    });
    assert.equal(core.ledger.getState("reviewedPlanHash"), completed.afterHash);
    assert.equal(core.currentWorkflowRun()?.checkpoint, "reviewed");
    assert.deepEqual(core.ledger.getManualEdit(started.id), completed);
    const eventPayload = JSON.stringify(core.ledger.listEvents({ kind: "manual_edit.completed" })[0]?.payload);
    assert.equal(eventPayload.includes(VALID_PLAN), false);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed review records additions, removals, and field edits", () => {
  const root = createTemporaryRepository("atlr-plan-review-diff-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Review structural changes");
    const started = core.beginPlanReview({ editor: editor() });
    const edited = VALID_PLAN
      .replace("Create the guarded core.", "Create the durable guarded core.")
      .replace("## ATLR-002 — Add task-backed working state", "## ATLR-003 — Replacement task")
      .replaceAll('"id":"ATLR-002"', '"id":"ATLR-003"')
      .replaceAll("- ATLR-001", "- None");
    writeFileSync(planPath, edited, "utf8");

    const completed = core.completePlanReview(started.id, { exitCode: 0 });

    assert.equal(completed.status, "completed");
    assert.equal(completed.changed, true);
    assert.deepEqual(completed.changedPaths, [planPath]);
    assert.deepEqual(completed.structuralDiff?.added, ["ATLR-003"]);
    assert.deepEqual(completed.structuralDiff?.removed, ["ATLR-002"]);
    assert.ok(completed.structuralDiff?.changed.some((change) =>
      change.id === "ATLR-001" && change.fields.includes("goal"),
    ));
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocking diagnostics complete the evidence but do not advance review", () => {
  const root = createTemporaryRepository("atlr-plan-review-invalid-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Review an invalid plan");
    const started = core.beginPlanReview({ editor: editor() });
    writeFileSync(planPath, "# Invalid plan\n", "utf8");
    const completed = core.completePlanReview(started.id, { exitCode: 0 });

    assert.equal(completed.status, "completed");
    assert.equal(completed.accepted, false);
    assert.ok(completed.diagnostics?.some((diagnostic) => diagnostic.code === "no_tasks"));
    assert.equal(core.ledger.getState("reviewedPlanHash"), undefined);
    assert.equal(core.currentWorkflowRun()?.checkpoint, "review_pending");
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("editor failure and interruption leave durable non-completed evidence", () => {
  const root = createTemporaryRepository("atlr-plan-review-failure-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Handle editor failure");
    const failedStart = core.beginPlanReview({ editor: editor() });
    writeFileSync(planPath, VALID_PLAN.replace("Create the guarded core.", "Partially saved."), "utf8");
    const failed = core.cancelPlanReview(failedStart.id, {
      status: "failed",
      exitCode: 2,
      error: "editor failed",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "editor failed");
    assert.equal(failed.changed, true);
    assert.ok(failed.structuralDiff?.changed.some((change) => change.fields.includes("goal")));
    assert.equal(core.currentWorkflowRun()?.checkpoint, "review_pending");

    const interruptedStart = core.beginPlanReview({ editor: editor() });
    const interrupted = core.cancelPlanReview(interruptedStart.id, {
      status: "interrupted",
      signal: "SIGINT",
    });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.signal, "SIGINT");
    assert.equal(core.ledger.getState("reviewedPlanHash"), undefined);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan deletion records failure and cannot advance the reviewed checkpoint", () => {
  const root = createTemporaryRepository("atlr-plan-review-deleted-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Handle plan deletion");
    const started = core.beginPlanReview({ editor: editor() });
    unlinkSync(planPath);

    assert.throws(() => core.completePlanReview(started.id, { exitCode: 0 }), /removed/);
    assert.equal(existsSync(planPath), false);
    assert.equal(core.ledger.getManualEdit(started.id)?.status, "failed");
    assert.equal(core.currentWorkflowRun()?.checkpoint, "review_pending");
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("version-one ledgers migrate in place and workflow transitions are atomic", () => {
  const root = createTemporaryRepository("atlr-plan-review-migration-");
  const databasePath = join(root, ".atelier", "legacy.db");
  const Database = loadDatabaseSync();
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'before');
    CREATE TABLE state(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO state(key, value_json, updated_at) VALUES ('preserved', '"value"', 'before');
  `);
  legacy.close();

  const ledger = new SqliteLedger(databasePath);
  try {
    assert.equal(ledger.getState("preserved"), "value");
    const migrations = ledger.database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number }>;
    assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4]);

    const run: WorkflowRun = {
      id: "workflow-atomic",
      status: "active",
      checkpoint: "drafting",
      objective: "atomic transition",
      planPath: join(root, ".atelier", "PLAN.md"),
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => ledger.saveWorkflowTransition({
      run,
      event: { kind: "workflow.started", actor: "user", payload: circular },
    }));
    assert.equal(ledger.getWorkflowRun(run.id), undefined);
    assert.equal(ledger.listEvents({ kind: "workflow.started" }).length, 0);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent repository drift marks the review ambiguous and blocks advancement", () => {
  const root = createTemporaryRepository("atlr-plan-review-drift-");
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  writeFileSync(join(root, "source.txt"), "before\n", "utf8");
  const core = openCore(root);
  try {
    core.beginPlan("Detect source drift");
    const started = core.beginPlanReview({ editor: editor() });
    writeFileSync(join(root, "source.txt"), "after\n", "utf8");
    const completed = core.completePlanReview(started.id, { exitCode: 0 });

    assert.equal(completed.status, "completed");
    assert.equal(completed.ambiguous, true);
    assert.equal(completed.driftStatus, "repository_changed");
    assert.equal(completed.accepted, false);
    assert.equal(core.ledger.getState("reviewedPlanHash"), undefined);
    assert.equal(core.currentWorkflowRun()?.checkpoint, "review_pending");
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
