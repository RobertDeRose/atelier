import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import type {
  CreateTaskRequest,
  RepositorySnapshot,
  TaskProviderStatus,
  TaskRecord,
} from "../packages/core/src/domain/types.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { AtelierCore } from "../packages/core/src/core.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { parsePlanFile } from "../packages/core/src/planning/plan-parser.ts";
import { PlanReconciler } from "../packages/core/src/planning/plan-reconciler.ts";
import type { RepositoryCommitResult, RepositoryProvider, RepositoryProviderStatus } from "../packages/core/src/repository/repository-provider.ts";
import { InMemoryTaskProvider } from "../packages/core/src/tasks/in-memory-task-provider.ts";
import { ExecutionWorkflowCoordinator } from "../packages/core/src/workflow/execution-workflow-coordinator.ts";
import { createTemporaryRepository, testDatabasePath, VALID_PLAN } from "./fixtures.ts";

class MutableRepository implements RepositoryProvider {
  readonly name = "git" as const;
  current: RepositorySnapshot = {
    repositoryId: "repository",
    workspaceId: "workspace",
    vcs: "git",
    headCommit: "head",
    dirtyGeneration: 0,
    dirtyFingerprint: "clean",
    indexSchemaVersion: 1,
  };
  status(): RepositoryProviderStatus { return { provider: "git", available: true, repository: true }; }
  snapshot(): RepositorySnapshot { return structuredClone(this.current); }
  changedPaths(): string[] { return []; }
  rawChangedPaths(): string[] { return []; }
  changedPathsFrom(): string[] { return []; }
  diff(): string { return ""; }
  diffFrom(): string { return ""; }
  listFiles(): string[] { return []; }
  commit(message: string): RepositoryCommitResult {
    return { message, changedPaths: [], snapshot: this.snapshot() };
  }
  commitMetadata(message: string): RepositoryCommitResult {
    return { message, changedPaths: [], snapshot: this.snapshot() };
  }
}

class RecordingProvider extends InMemoryTaskProvider {
  creates = 0;
  claims = 0;
  lists = 0;
  statuses = 0;
  initializes = 0;
  version = "1";
  available = true;
  initialized = true;
  failCreateAt?: number;
  failClaim = false;
  hideReady = false;

  override async status(): Promise<TaskProviderStatus> {
    this.statuses += 1;
    return {
      provider: this.name,
      available: this.available,
      initialized: this.initialized,
      version: this.version,
      ...(this.available ? {} : { reason: "provider unavailable" }),
    };
  }
  override async list(): Promise<TaskRecord[]> {
    this.lists += 1;
    return super.list();
  }
  override async initialize(): Promise<void> {
    this.initializes += 1;
    this.initialized = true;
  }
  override async create(request: CreateTaskRequest): Promise<TaskRecord> {
    this.creates += 1;
    if (this.failCreateAt === this.creates) throw new Error("partial reconciliation failure");
    return super.create(request);
  }
  override async claim(taskId: string): Promise<TaskRecord> {
    this.claims += 1;
    if (this.failClaim) throw new Error("claim failure");
    return super.claim(taskId);
  }
  override async ready(): Promise<TaskRecord[]> {
    return this.hideReady ? [] : super.ready();
  }
}

function setup(prefix: string, provider = new RecordingProvider()): {
  root: string;
  ledger: SqliteLedger;
  provider: RecordingProvider;
  repository: MutableRepository;
  coordinator: ExecutionWorkflowCoordinator;
  databasePath: string;
} {
  const root = createTemporaryRepository(prefix);
  const planPath = join(root, ".atelier", "PLAN.md");
  writeFileSync(planPath, VALID_PLAN, "utf8");
  const databasePath = testDatabasePath(root).replace(/atelier\.db$/, "execution.db");
  const ledger = new SqliteLedger(databasePath);
  const plan = parsePlanFile(planPath);
  ledger.setState("reviewedPlanHash", plan.hash);
  ledger.setState("workflowMode", "plan");
  const repository = new MutableRepository();
  return {
    root,
    ledger,
    provider,
    repository,
    databasePath,
    coordinator: new ExecutionWorkflowCoordinator({ planPath, ledger, provider, repository, repositoryRoot: root }),
  };
}

test("exact approval rejection performs no provider mutation and creates no execution grant", async () => {
  const context = setup("atlr-execution-reject-");
  try {
    const prepared = await context.coordinator.prepare();
    assert.equal(context.provider.creates, 0);
    const rejected = await context.coordinator.approveAndApply(prepared.approval.id, false);
    assert.equal(rejected.approval.status, "rejected");
    assert.equal(context.provider.creates, 0);
    assert.equal(context.provider.claims, 0);
    assert.equal(context.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(context.ledger.getState("workflowMode"), "plan");
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("approval rechecks and serializes against an execution grant that became active after preparation", async () => {
  const context = setup("atlr-execution-concurrent-");
  try {
    const prepared = await context.coordinator.prepare();
    context.ledger.saveExecutionGrant({
      id: "execution-concurrent",
      status: "active",
      planApprovalId: "other-approval",
      reconciliationTransactionId: "other-transaction",
      planHash: "other-plan",
      reconciliationDigest: "other-reconciliation",
      provider: { name: context.provider.name, version: "1" },
      workspaceId: context.repository.current.workspaceId,
      repositoryId: context.repository.current.repositoryId,
      repositorySnapshot: prepared.approval.repositorySnapshot,
      repositoryBindings: prepared.approval.repositoryBindings,
      retrievalBindings: prepared.approval.retrievalBindings,
      approvalConstraintDigest: prepared.approval.constraintDigest,
      constraintDigest: prepared.approval.constraintDigest,
      taskId: "other-task",
      planTaskId: "OTHER",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });

    await assert.rejects(
      context.coordinator.approveAndApply(prepared.approval.id, true),
      /became active after preparation/i,
    );
    assert.equal(context.provider.creates, 0);
    assert.equal(context.provider.claims, 0);
    assert.equal(context.ledger.getPlanApproval(prepared.approval.id)?.status, "invalidated");
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("successful exact approval reconciles, claims, then atomically enters act mode with a task grant", async () => {
  const context = setup("atlr-execution-success-");
  try {
    const prepared = await context.coordinator.prepare();
    assert.equal(prepared.approval.planHash, prepared.reconciliation.planHash);
    assert.equal(prepared.approval.reconciliationDigest, prepared.reconciliation.digest);
    const phases: string[] = [];
    const result = await context.coordinator.approveAndApply(prepared.approval.id, true, {
      onPhase: (phase) => { phases.push(phase); },
    });

    assert.equal(result.transaction.status, "applied");
    assert.equal(result.reconciliation.applied, true);
    assert.equal(result.task?.status, "in_progress");
    assert.equal(result.executionGrant?.status, "active");
    assert.equal(result.executionGrant?.taskId, result.task?.id);
    assert.equal(context.ledger.getState("workflowMode"), "act");
    assert.equal(context.ledger.getState("currentTaskId"), result.task?.id);
    assert.equal(prepared.approval.taskConstraints.filter((item) => item.planTaskId === result.task?.planTaskId).length, 1, "approval retains one reviewed task constraint for the active task");
    assert.deepEqual(phases, ["revalidate", "reconcile", "converge", "activate"]);
    assert.equal(context.provider.lists, 3, "prepare, exact revalidation, and convergence each use one provider inventory");
    assert.equal(context.provider.statuses, 4, "provider status is bounded to preparation and three reconciliation previews");
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("hash drift, provider drift, partial reconciliation, no ready task, and claim failure fail closed", async () => {
  for (const scenario of ["hash", "provider", "partial", "ready", "claim"] as const) {
    const context = setup(`atlr-execution-${scenario}-`);
    try {
      if (scenario === "partial") context.provider.failCreateAt = 2;
      if (scenario === "ready") context.provider.hideReady = true;
      if (scenario === "claim") context.provider.failClaim = true;
      const prepared = await context.coordinator.prepare();
      if (scenario === "hash") {
        writeFileSync(join(context.root, ".atelier", "PLAN.md"), VALID_PLAN.replace("guarded core", "drifted core"), "utf8");
      }
      if (scenario === "provider") context.provider.version = "2";

      await assert.rejects(
        context.coordinator.approveAndApply(prepared.approval.id, true),
        /changed after preparation|partial reconciliation|no approved-plan task is ready|claim failure/i,
        scenario,
      );
      assert.equal(context.ledger.getActiveExecutionGrant(), undefined, scenario);
      assert.equal(context.ledger.getState("workflowMode"), "plan", scenario);
      assert.equal(context.ledger.getState("approvedPlanHash"), undefined, scenario);
      assert.equal(context.ledger.listPlanApprovals()[0]?.status, "invalidated", scenario);
    } finally {
      context.ledger.close();
      rmSync(context.root, { recursive: true, force: true });
    }
  }
});

test("provider preparation is separately confirmed and unavailable providers cannot prepare approval", async () => {
  const context = setup("atlr-execution-provider-");
  try {
    context.provider.initialized = false;
    assert.equal(await context.coordinator.initializeProvider(false), false);
    assert.equal(context.provider.initializes, 0);
    assert.equal(await context.coordinator.initializeProvider(true), true);
    assert.equal(context.provider.initializes, 1);

    context.provider.available = false;
    await assert.rejects(context.coordinator.prepare(), /provider unavailable/i);
    assert.equal(context.provider.creates, 0);
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("cancellation revokes execution without altering task status", async () => {
  const context = setup("atlr-execution-cancel-");
  try {
    const prepared = await context.coordinator.prepare();
    const started = await context.coordinator.approveAndApply(prepared.approval.id, true);
    const grant = started.executionGrant;
    assert.ok(grant);

    const cancelled = context.coordinator.cancel("user cancelled execution");
    assert.equal(cancelled?.status, "revoked");
    assert.equal(context.ledger.getActiveExecutionGrant(), undefined);
    assert.equal((await context.provider.get(grant.taskId))?.status, "in_progress");
    assert.equal(context.ledger.getState("workflowMode"), "plan");
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("workspace approval decisions are concrete and never create remembered grants", async () => {
  const root = createTemporaryRepository("atlr-execution-operation-");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    const effect = [{ kind: "unknown" as const, description: "unbounded command" }];
    assert.equal(core.evaluateWorkspaceEffects(effect).result, "ask");
    assert.equal(core.evaluateWorkspaceEffects(effect).result, "ask");
    const table = core.ledger.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'").get();
    assert.equal(table, undefined);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart preserves a valid grant and invalidates stale plan, provider, workspace, or task bindings", async () => {
  for (const drift of ["none", "plan", "provider", "unavailable", "workspace", "repository", "task"] as const) {
    const context = setup(`atlr-execution-resume-${drift}-`);
    const prepared = await context.coordinator.prepare();
    const started = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(started.executionGrant);
    const taskId = started.executionGrant.taskId;
    context.ledger.close();

    const reopened = new SqliteLedger(context.databasePath);
    const resumed = new ExecutionWorkflowCoordinator({
      planPath: join(context.root, ".atelier", "PLAN.md"),
      ledger: reopened,
      provider: context.provider,
      repository: context.repository,
      repositoryRoot: context.root,
    });
    try {
      if (drift === "plan") writeFileSync(join(context.root, ".atelier", "PLAN.md"), VALID_PLAN.replace("guarded core", "changed core"), "utf8");
      if (drift === "provider") context.provider.version = "2";
      if (drift === "unavailable") context.provider.available = false;
      if (drift === "workspace") context.repository.current.workspaceId = "other-workspace";
      if (drift === "repository") context.repository.current.repositoryId = "other-repository";
      if (drift === "task") await context.provider.close(taskId, "completed elsewhere");

      const grant = await resumed.resume();
      if (drift === "none") {
        assert.equal(grant?.status, "active");
        assert.equal(reopened.getState("workflowMode"), "act");
      } else {
        assert.equal(grant, undefined);
        assert.equal(reopened.getActiveExecutionGrant(), undefined);
        assert.equal(reopened.getState("workflowMode"), "plan");
        assert.match(reopened.listExecutionGrants()[0]?.invalidationReason ?? "", /changed|unavailable|status/i);
      }
    } finally {
      reopened.close();
      rmSync(context.root, { recursive: true, force: true });
    }
  }
});

test("restart fails an applying transaction closed and a fresh confirmation recovers an already claimed task", async () => {
  const context = setup("atlr-execution-interrupted-");
  try {
    const prepared = await context.coordinator.prepare();
    const accepted = { ...prepared.approval, status: "accepted" as const, decidedAt: "2026-01-01T00:00:00.000Z" };
    const applying = { ...prepared.transaction, status: "applying" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
    context.ledger.beginExecutionApplication(accepted, applying);
    const plan = parsePlanFile(join(context.root, ".atelier", "PLAN.md"));
    await new PlanReconciler(context.provider, context.ledger).apply(plan, prepared.reconciliation);
    const first = (await context.provider.ready())[0];
    assert.ok(first);
    await context.provider.claim(first.id);
    context.ledger.close();

    const reopened = new SqliteLedger(context.databasePath);
    const coordinator = new ExecutionWorkflowCoordinator({
      planPath: join(context.root, ".atelier", "PLAN.md"),
      ledger: reopened,
      provider: context.provider,
      repository: context.repository,
      repositoryRoot: context.root,
    });
    try {
      assert.equal(await coordinator.resume(), undefined);
      assert.equal(reopened.getPlanApproval(accepted.id)?.status, "invalidated");
      assert.equal(reopened.getReconciliationTransaction(applying.id)?.status, "failed");
      assert.equal(reopened.getState("approvedPlanHash"), undefined);

      const retry = await coordinator.prepare();
      const recovered = await coordinator.approveAndApply(retry.approval.id, true);
      assert.equal(recovered.task?.id, first.id);
      assert.equal(recovered.executionGrant?.status, "active");
      assert.equal(context.provider.claims, 1, "the already claimed task was inspected instead of claimed twice");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("later-task activation failure after claim fails closed and is recoverable without a second claim", async () => {
  const context = setup("atlr-execution-next-failure-");
  try {
    const prepared = await context.coordinator.prepare();
    const first = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(first.task);
    await context.provider.close(first.task.id, "completed");

    const activate = context.ledger.activateExecution.bind(context.ledger);
    context.ledger.activateExecution = () => { throw new Error("activation persistence failure"); };
    await assert.rejects(context.coordinator.startNextTask(true), /activation persistence failure/);
    context.ledger.activateExecution = activate;

    assert.equal(context.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(context.ledger.getState("workflowMode"), "plan");
    assert.equal(context.ledger.getPlanApproval(first.approval.id)?.status, "invalidated");
    const inProgress = (await context.provider.list()).filter((task) => task.status === "in_progress");
    assert.equal(inProgress.length, 1);
    assert.equal(context.provider.claims, 2);

    const retry = await context.coordinator.prepare();
    const recovered = await context.coordinator.approveAndApply(retry.approval.id, true);
    assert.equal(recovered.task?.id, inProgress[0]?.id);
    assert.equal(context.provider.claims, 2);
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("starting a later task requires confirmation while reusing unchanged plan approval", async () => {
  const context = setup("atlr-execution-next-");
  try {
    const prepared = await context.coordinator.prepare();
    const first = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(first.task);
    await context.provider.close(first.task.id, "completed");

    assert.equal(await context.coordinator.startNextTask(false), undefined);
    const next = await context.coordinator.startNextTask(true);
    assert.equal(next?.task.planTaskId, "ATLR-002");
    assert.equal(next?.executionGrant.planApprovalId, first.executionGrant?.planApprovalId);
    assert.equal(context.provider.claims, 2);
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("starting an explicitly requested later task works after explicit closure revoked the prior grant", async () => {
  const context = setup("atlr-execution-next-closed-");
  try {
    const prepared = await context.coordinator.prepare();
    const first = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(first.task);
    await context.provider.close(first.task.id, "completed");
    context.coordinator.cancel(`Task ${first.task.id} was explicitly closed.`);

    const ready = await context.provider.ready();
    const requested = ready.find((task) => task.planTaskId === "ATLR-002");
    assert.ok(requested);
    const next = await context.coordinator.startNextTask(true, requested.id);
    assert.equal(next?.task.id, requested.id);
    assert.equal(next?.executionGrant.planApprovalId, first.executionGrant?.planApprovalId);

    context.coordinator.cancel("cancelled without closing the active task");
    await assert.rejects(
      context.coordinator.startNextTask(true),
      /status in_progress/i,
    );
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});


test("legacy execution records without an exact task constraint projection fail closed on resume", async () => {
  const context = setup("atlr-execution-legacy-capabilities-");
  try {
    const prepared = await context.coordinator.prepare();
    const started = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(started.executionGrant);
    for (const [table, id] of [
      ["plan_approvals", started.approval.id],
      ["execution_grants", started.executionGrant.id],
    ] as const) {
      const row = context.ledger.database.prepare(`SELECT record_json FROM ${table} WHERE id = ?`).get(id) as { record_json: string };
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      delete record.constraintDigest;
      if (table === "execution_grants") delete record.approvalConstraintDigest;
      if (table === "plan_approvals") delete record.taskConstraints;
      context.ledger.database.prepare(`UPDATE ${table} SET record_json = ? WHERE id = ?`).run(JSON.stringify(record), id);
    }
    context.ledger.close();

    const reopened = new SqliteLedger(context.databasePath);
    const coordinator = new ExecutionWorkflowCoordinator({
      planPath: join(context.root, ".atelier", "PLAN.md"),
      ledger: reopened,
      provider: context.provider,
      repository: context.repository,
      repositoryRoot: context.root,
    });
    try {
      assert.equal(await coordinator.resume(), undefined);
      assert.match(reopened.listExecutionGrants()[0]?.invalidationReason ?? "", /constraint projection/i);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("alpha.5 plans without structured execution contracts invalidate active execution on resume", async () => {
  const context = setup("atlr-execution-legacy-plan-contract-");
  try {
    const prepared = await context.coordinator.prepare();
    const started = await context.coordinator.approveAndApply(prepared.approval.id, true);
    assert.ok(started.executionGrant);

    const planPath = join(context.root, ".atelier", "PLAN.md");
    const legacyPlanText = VALID_PLAN.replace(/,"execution":\{[^\n]+\}/g, "");
    writeFileSync(planPath, legacyPlanText, "utf8");
    const legacyPlan = parsePlanFile(planPath);
    assert.ok(legacyPlan.diagnostics.some((item) => item.code === "missing_execution_contract"));

    context.ledger.savePlanApproval({ ...started.approval, planHash: legacyPlan.hash });
    context.ledger.saveExecutionGrant({ ...started.executionGrant, planHash: legacyPlan.hash });

    assert.equal(await context.coordinator.resume(), undefined);
    assert.equal(context.ledger.getActiveExecutionGrant(), undefined);
    assert.match(
      context.ledger.listExecutionGrants().at(-1)?.invalidationReason ?? "",
      /execution contract|machine-readable/i,
    );
  } finally {
    context.ledger.close();
    rmSync(context.root, { recursive: true, force: true });
  }
});
