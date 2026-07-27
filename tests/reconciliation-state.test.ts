import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { InMemoryTaskProvider } from "../packages/core/src/tasks/in-memory-task-provider.ts";
import { PlanReconciler } from "../packages/core/src/planning/plan-reconciler.ts";
import { parsePlanText } from "../packages/core/src/planning/plan-parser.ts";
import { WorkingStateBuilder } from "../packages/core/src/state/working-state-builder.ts";
import type { TaskProvider } from "../packages/core/src/tasks/task-provider.ts";
import type { CreateTaskRequest, TaskPatch, TaskProviderCapabilities, TaskProviderStatus, TaskRecord } from "../packages/core/src/domain/types.ts";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";
import { assertTaskProviderConformance } from "./task-provider-conformance.ts";

function reconciliationPlan(tasks: Array<{
  id: string;
  title: string;
  dependencies?: string[];
}>): string {
  return `# Reconciliation Plan\n\n<!-- atlr:plan version="1" -->\n\n${tasks.map((task) => `## ${task.id} — ${task.title}
<!-- atlr:task {"id":"${task.id}","priority":1,"type":"task"} -->

### Goal

Deliver ${task.id}.

### Scope

- packages/core

### Out of scope

- None

### Depends on

${task.dependencies?.map((dependency) => `- ${dependency}`).join("\n") || "- None"}

### Validation

- Run focused tests

### Completion criteria

- ${task.id} is complete

### Notes

- Deterministic
`).join("\n")}`;
}

const snapshot = {
  repositoryId: "repo",
  workspaceId: "workspace",
  vcs: "git" as const,
  headCommit: "HEAD",
  dirtyGeneration: 0,
  dirtyFingerprint: "clean",
  indexSchemaVersion: 1,
};

test("reconciliation is idempotent and Working State advances through ready tasks", async () => {
  const root = createTemporaryRepository("atlr-reconcile-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new InMemoryTaskProvider();
  try {
    const plan = parsePlanText(VALID_PLAN, join(root, ".atelier", "PLAN.md"));
    const reconciler = new PlanReconciler(provider, ledger);
    const preview = await reconciler.preview(plan);
    assert.equal(preview.operations.filter((operation) => operation.kind === "create").length, 2);

    const applied = await reconciler.apply(plan, preview);
    assert.equal(applied.applied, true);
    assert.equal(applied.created.length, 2);

    const secondPreview = await reconciler.preview(plan);
    assert.deepEqual(secondPreview.operations, []);

    const builder = new WorkingStateBuilder(provider, ledger);
    const first = await builder.build({ mode: "act", snapshot, plan });
    assert.equal(first.planTask?.id, "ATLR-001");
    assert.ok(first.activeTask);
    const activeTask = first.activeTask;

    await provider.close(activeTask.id, "validated");
    const second = await builder.build({ mode: "act", snapshot, plan });
    assert.equal(second.planTask?.id, "ATLR-002");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class FailingProvider implements TaskProvider {
  readonly name = "failing";
  private failure(): never {
    throw new Error("provider unavailable");
  }
  async capabilities(): Promise<TaskProviderCapabilities> { return this.failure(); }
  async status(): Promise<TaskProviderStatus> { return this.failure(); }
  async initialize(): Promise<void> { return this.failure(); }
  async ready(): Promise<TaskRecord[]> { return this.failure(); }
  async get(_taskId: string): Promise<TaskRecord | undefined> { return this.failure(); }
  async list(): Promise<TaskRecord[]> { return this.failure(); }
  async create(_request: CreateTaskRequest): Promise<TaskRecord> { return this.failure(); }
  async update(_taskId: string, _patch: TaskPatch): Promise<TaskRecord> { return this.failure(); }
  async claim(_taskId: string): Promise<TaskRecord> { return this.failure(); }
  async addDependency(_taskId: string, _dependencyTaskId: string): Promise<void> { return this.failure(); }
  async removeDependency(_taskId: string, _dependencyTaskId: string): Promise<void> { return this.failure(); }
  async close(_taskId: string, _reason: string): Promise<TaskRecord> { return this.failure(); }
}

test("reconciliation previews and converges create, adopt, update, link, unlink, and retire operations", async () => {
  const root = createTemporaryRepository("atlr-reconcile-complete-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new InMemoryTaskProvider();
  try {
    const initial = parsePlanText(reconciliationPlan([
      { id: "ATLR-A", title: "Original A" },
      { id: "ATLR-OLD", title: "Retired task" },
    ]));
    const initialResult = await new PlanReconciler(provider, ledger).apply(initial);
    const aId = ledger.getTaskMapping("ATLR-A")?.providerTaskId;
    const oldId = ledger.getTaskMapping("ATLR-OLD")?.providerTaskId;
    assert.ok(aId);
    assert.ok(oldId);
    await provider.addDependency(aId, oldId);
    const adopted = await provider.create({
      planTaskId: "ATLR-B",
      title: "Existing B",
      description: "Deliver ATLR-B.",
      design: "Deterministic",
      acceptanceCriteria: ["ATLR-B is complete", "Validation: Run focused tests"],
      priority: 1,
      type: "task",
      labels: ["atelier-plan"],
    });

    const revised = parsePlanText(reconciliationPlan([
      { id: "ATLR-B", title: "Existing B" },
      { id: "ATLR-A", title: "Revised A", dependencies: ["ATLR-B"] },
      { id: "ATLR-C", title: "New C", dependencies: ["ATLR-A"] },
    ]));
    const reconciler = new PlanReconciler(provider, ledger);
    const preview = await reconciler.preview(revised);
    assert.equal(preview.provider.name, "memory");
    assert.match(preview.digest, /^[a-f0-9]{64}$/);
    assert.equal(new Set(preview.operations.map((operation) => operation.operationId)).size, preview.operations.length);
    assert.deepEqual(
      [...new Set(preview.operations.map((operation) => operation.kind))].sort(),
      ["adopt", "create", "link", "retire", "unlink", "update"],
    );

    const applied = await reconciler.apply(revised, preview);
    assert.equal(applied.applied, true);
    assert.equal(applied.created.length, 1);
    assert.equal(ledger.getTaskMapping("ATLR-B")?.providerTaskId, adopted.id);
    assert.equal((await provider.get(oldId))?.status, "closed");
    assert.deepEqual((await provider.get(aId))?.dependencies, [adopted.id]);
    const cId = ledger.getTaskMapping("ATLR-C")?.providerTaskId;
    assert.ok(cId);
    assert.deepEqual((await provider.get(cId))?.dependencies, [aId]);
    assert.ok(ledger.listTaskMappings().filter((mapping) => revised.tasks.some((task) => task.id === mapping.planTaskId))
      .every((mapping) => mapping.planHash === revised.hash));

    const secondPreview = await reconciler.preview(revised);
    assert.deepEqual(secondPreview.operations, []);
    assert.deepEqual(secondPreview.unchanged, ["ATLR-B", "ATLR-A", "ATLR-C"]);
    assert.equal(initialResult.applied, true);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation adopts a uniquely marked task after create crashes before mapping storage", async () => {
  class CrashAfterCreateProvider extends InMemoryTaskProvider {
    crash = true;
    override async create(request: CreateTaskRequest): Promise<TaskRecord> {
      const task = await super.create(request);
      if (this.crash) {
        this.crash = false;
        throw new Error("crash after provider create");
      }
      return task;
    }
  }
  const root = createTemporaryRepository("atlr-reconcile-crash-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new CrashAfterCreateProvider();
  const plan = parsePlanText(reconciliationPlan([{ id: "ATLR-CRASH", title: "Crash safe" }]));
  try {
    await assert.rejects(new PlanReconciler(provider, ledger).apply(plan), /crash after provider create/);
    assert.equal((await provider.list()).length, 1);
    assert.equal(ledger.listEvents({ kind: "reconciliation.operation_failed" }).length, 1);
    const resumed = new PlanReconciler(provider, ledger);
    const preview = await resumed.preview(plan);
    assert.deepEqual(preview.operations.map((operation) => operation.kind), ["adopt"]);
    await resumed.apply(plan, preview);
    assert.equal((await provider.list()).length, 1);
    assert.ok(ledger.getTaskMapping("ATLR-CRASH"));
    assert.equal(ledger.listReconciliationCheckpoints(preview.digest).some((item) => item.status === "completed"), true);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation blocks ambiguous markers, provider drift, disappeared mappings, and reused stable IDs", async () => {
  const root = createTemporaryRepository("atlr-reconcile-conflicts-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const plan = parsePlanText(reconciliationPlan([
    { id: "ATLR-AMBIGUOUS", title: "Ambiguous" },
    { id: "ATLR-MISSING", title: "Missing" },
    { id: "ATLR-REUSED", title: "Reused" },
  ]));
  const provider = new InMemoryTaskProvider();
  try {
    await provider.create({ planTaskId: "ATLR-AMBIGUOUS", title: "One", description: "One", acceptanceCriteria: [], priority: 1, type: "task" });
    await provider.create({ planTaskId: "ATLR-AMBIGUOUS", title: "Two", description: "Two", acceptanceCriteria: [], priority: 1, type: "task" });
    const reused = await provider.create({ planTaskId: "OTHER", title: "Other", description: "Other", acceptanceCriteria: [], priority: 1, type: "task" });
    ledger.setTaskMapping("ATLR-MISSING", provider.name, "missing", "old");
    ledger.setTaskMapping("ATLR-REUSED", provider.name, reused.id, "old");

    const preview = await new PlanReconciler(provider, ledger).preview(plan);
    assert.equal(preview.operations.filter((operation) => operation.kind === "conflict").length, 3);
    assert.match(preview.conflicts.join("\n"), /multiple provider tasks/i);
    assert.match(preview.conflicts.join("\n"), /no longer exists/i);
    assert.match(preview.conflicts.join("\n"), /stable plan id OTHER/i);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent provider return ordering produces identical operation ids and reconciliation digests", async () => {
  class ReverseListProvider extends InMemoryTaskProvider {
    override async list(): Promise<TaskRecord[]> {
      return (await super.list()).reverse();
    }
  }
  const rootOne = createTemporaryRepository("atlr-reconcile-order-one-");
  const rootTwo = createTemporaryRepository("atlr-reconcile-order-two-");
  const ledgerOne = new SqliteLedger(join(rootOne, ".atelier", "test.db"));
  const ledgerTwo = new SqliteLedger(join(rootTwo, ".atelier", "test.db"));
  const providerOne = new InMemoryTaskProvider();
  try {
    const original = parsePlanText(reconciliationPlan([
      { id: "ATLR-A", title: "A" },
      { id: "ATLR-B", title: "B" },
    ]));
    await new PlanReconciler(providerOne, ledgerOne).apply(original);
    const records = await providerOne.list();
    for (const mapping of ledgerOne.listTaskMappings()) {
      ledgerTwo.setTaskMapping(mapping.planTaskId, mapping.provider, mapping.providerTaskId, mapping.planHash);
    }
    const providerTwo = new ReverseListProvider(records);
    const revised = parsePlanText(reconciliationPlan([{ id: "ATLR-A", title: "Revised A" }]));
    const first = await new PlanReconciler(providerOne, ledgerOne).preview(revised);
    const second = await new PlanReconciler(providerTwo, ledgerTwo).preview(revised);
    assert.equal(first.digest, second.digest);
    assert.deepEqual(first.operations.map((operation) => operation.operationId), second.operations.map((operation) => operation.operationId));
  } finally {
    ledgerOne.close();
    ledgerTwo.close();
    rmSync(rootOne, { recursive: true, force: true });
    rmSync(rootTwo, { recursive: true, force: true });
  }
});

test("reconciliation refuses provider drift, unsupported removals, and unexpected provider edits", async () => {
  class MutableCapabilityProvider extends InMemoryTaskProvider {
    version = "1";
    allowRemoval = true;
    override async status(): Promise<TaskProviderStatus> {
      return { provider: this.name, available: true, initialized: true, version: this.version };
    }
    override async capabilities(): Promise<TaskProviderCapabilities> {
      return { stablePlanTaskIds: true, dependencyRemoval: this.allowRemoval, retirement: this.allowRemoval };
    }
  }
  const root = createTemporaryRepository("atlr-reconcile-drift-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new MutableCapabilityProvider();
  try {
    const plan = parsePlanText(reconciliationPlan([
      { id: "ATLR-A", title: "A" },
      { id: "ATLR-B", title: "B", dependencies: ["ATLR-A"] },
    ]));
    const reconciler = new PlanReconciler(provider, ledger);
    await reconciler.apply(plan);

    const bId = ledger.getTaskMapping("ATLR-B")?.providerTaskId;
    assert.ok(bId);
    await provider.update(bId, { title: "Externally edited" });
    const unexpected = await reconciler.preview(plan);
    assert.match(unexpected.conflicts.join("\n"), /changed unexpectedly/i);
    await provider.update(bId, { title: "B" });
    const aId = ledger.getTaskMapping("ATLR-A")?.providerTaskId;
    assert.ok(aId);
    await provider.removeDependency(bId, aId);
    const dependencyDrift = await reconciler.preview(plan);
    assert.match(dependencyDrift.conflicts.join("\n"), /dependencies.*changed unexpectedly/i);
    await provider.addDependency(bId, aId);

    const revised = parsePlanText(reconciliationPlan([
      { id: "ATLR-A", title: "A" },
      { id: "ATLR-B", title: "B" },
    ]));
    provider.allowRemoval = false;
    const unsupported = await reconciler.preview(revised);
    assert.match(unsupported.conflicts.join("\n"), /cannot remove dependency/i);

    provider.allowRemoval = true;
    const approved = await reconciler.preview(revised);
    provider.version = "2";
    const drifted = await reconciler.apply(revised, approved);
    assert.equal(drifted.applied, false);
    assert.match(drifted.conflicts.join("\n"), /state changed after.*preview|identity changed/i);
    assert.deepEqual((await provider.get(bId))?.dependencies.length, 1);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation blocks unsafe creation and rejects missing stable markers", async () => {
  class UnsupportedStableIdsProvider extends InMemoryTaskProvider {
    override async capabilities(): Promise<TaskProviderCapabilities> {
      return { stablePlanTaskIds: false, dependencyRemoval: true, retirement: true };
    }
  }
  class MissingReturnedMarkerProvider extends InMemoryTaskProvider {
    override async create(request: CreateTaskRequest): Promise<TaskRecord> {
      const task = await super.create(request);
      const { planTaskId: _planTaskId, ...withoutMarker } = task;
      return withoutMarker;
    }
  }
  const root = createTemporaryRepository("atlr-reconcile-stable-id-");
  const plan = parsePlanText(reconciliationPlan([{ id: "ATLR-STABLE", title: "Stable" }]));
  const unsupportedLedger = new SqliteLedger(join(root, ".atelier", "unsupported.db"));
  const markerLedger = new SqliteLedger(join(root, ".atelier", "marker.db"));
  try {
    const unsupported = await new PlanReconciler(new UnsupportedStableIdsProvider(), unsupportedLedger).preview(plan);
    assert.equal(unsupported.operations.some((operation) => operation.kind === "create"), false);
    assert.match(unsupported.conflicts.join("\n"), /stable plan task ids are unsupported/i);

    const provider = new MissingReturnedMarkerProvider();
    await assert.rejects(new PlanReconciler(provider, markerLedger).apply(plan), /stable plan id none/i);
    assert.equal((await provider.list()).length, 1);
    const recovery = await new PlanReconciler(provider, markerLedger).preview(plan);
    assert.deepEqual(recovery.operations.map((operation) => operation.kind), ["adopt"]);
  } finally {
    unsupportedLedger.close();
    markerLedger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reorder-only reconciliation refreshes surviving mapping hashes without provider mutations", async () => {
  const root = createTemporaryRepository("atlr-reconcile-reorder-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new InMemoryTaskProvider();
  try {
    const first = parsePlanText(reconciliationPlan([
      { id: "ATLR-A", title: "A" },
      { id: "ATLR-B", title: "B" },
    ]));
    await new PlanReconciler(provider, ledger).apply(first);
    const reordered = parsePlanText(reconciliationPlan([
      { id: "ATLR-B", title: "B" },
      { id: "ATLR-A", title: "A" },
    ]));
    const reconciler = new PlanReconciler(provider, ledger);
    const preview = await reconciler.preview(reordered);
    assert.deepEqual(preview.operations, []);
    await reconciler.apply(reordered, preview);
    assert.ok(ledger.listTaskMappings().every((mapping) => mapping.planHash === reordered.hash));
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-memory provider satisfies the shared reconciliation conformance", async () => {
  await assertTaskProviderConformance(new InMemoryTaskProvider());
});

test("task provider outages do not break read-only working state construction", async () => {
  const root = createTemporaryRepository("atlr-state-failure-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  try {
    ledger.setState("currentTaskId", "durable-current");
    const builder = new WorkingStateBuilder(new FailingProvider(), ledger);
    const state = await builder.build({ mode: "investigate", snapshot });
    assert.equal(state.activeTask, undefined);
    assert.equal(ledger.getState("currentTaskId"), "durable-current");
    assert.ok(state.omissions.some((message) => message.includes("provider unavailable")));
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Working State preserves reviewed plan order as the ready-task tie-breaker", async () => {
  const root = createTemporaryRepository("atlr-plan-order-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const plan = parsePlanText(reconciliationPlan([
    { id: "ATLR-B", title: "First in plan" },
    { id: "ATLR-A", title: "Second in plan" },
  ]));
  const provider = new InMemoryTaskProvider([
    { id: "provider-a", planTaskId: "ATLR-A", title: "Second", description: "", acceptanceCriteria: [], status: "open", priority: 1, type: "task", dependencies: [], labels: [] },
    { id: "provider-z", planTaskId: "ATLR-B", title: "First", description: "", acceptanceCriteria: [], status: "open", priority: 1, type: "task", dependencies: [], labels: [] },
  ]);
  try {
    ledger.setState("approvedPlanHash", plan.hash);
    const state = await new WorkingStateBuilder(provider, ledger).build({ mode: "act", snapshot, plan });
    assert.equal(state.activeTask?.id, "provider-z");
    assert.equal(state.planTask?.id, "ATLR-B");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved-plan selection excludes unrelated ready work and records the rationale", async () => {
  const root = createTemporaryRepository("atlr-approved-ready-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const plan = parsePlanText(VALID_PLAN, join(root, ".atelier", "PLAN.md"));
  const provider = new InMemoryTaskProvider([
    {
      id: "unrelated",
      title: "Unrelated urgent task",
      description: "Not part of the approved plan",
      acceptanceCriteria: [],
      status: "open",
      priority: 0,
      type: "task",
      dependencies: [],
      labels: [],
    },
    {
      id: "planned",
      planTaskId: "ATLR-001",
      title: "Establish guarded core",
      description: "Mapped to approved work",
      acceptanceCriteria: [],
      status: "open",
      priority: 2,
      type: "task",
      dependencies: [],
      labels: [],
    },
  ]);
  try {
    ledger.setState("approvedPlanHash", plan.hash);
    const builder = new WorkingStateBuilder(provider, ledger);
    const state = await builder.build({ mode: "act", snapshot, plan });

    assert.equal(state.activeTask?.id, "planned");
    assert.deepEqual(state.readyTasks.map((task) => task.id), ["planned"]);
    assert.equal(state.taskSelection.source, "ready");
    assert.match(state.taskSelection.rationale, /within approved plan/);
    const selected = ledger.listEvents({ kind: "task.selected" });
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0]?.payload, {
      provider: "memory",
      source: "ready",
      rationale: state.taskSelection.rationale,
    });
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Working State reconstructs blockers, durable corrections, and ManualEdit evidence", async () => {
  const root = createTemporaryRepository("atlr-state-durable-");
  const ledger = new SqliteLedger(join(root, ".atelier", "test.db"));
  const provider = new InMemoryTaskProvider([
    {
      id: "blocked-dependency",
      title: "Finish prerequisite",
      description: "Still open",
      acceptanceCriteria: [],
      status: "open",
      priority: 1,
      type: "task",
      dependencies: [],
      labels: [],
    },
    {
      id: "completed-dependency",
      title: "Completed prerequisite",
      description: "Already done",
      acceptanceCriteria: [],
      status: "closed",
      priority: 1,
      type: "task",
      dependencies: [],
      labels: [],
    },
    {
      id: "active",
      planTaskId: "ATLR-002",
      title: "Add task-backed working state",
      description: "Reconstruct durable evidence",
      acceptanceCriteria: ["State is bounded"],
      status: "in_progress",
      priority: 2,
      type: "feature",
      dependencies: ["blocked-dependency", "completed-dependency"],
      labels: [],
    },
  ]);
  try {
    ledger.setState("currentTaskId", "active");
    ledger.append({ kind: "correction", actor: "user", taskId: "active", payload: { message: "Preserve the user-edited plan." } });
    ledger.append({ kind: "manual_edit.completed", actor: "user", payload: { path: ".atelier/PLAN.md", changed: true } });
    for (let index = 0; index < 40; index += 1) {
      ledger.append({ kind: "noise", actor: "system", payload: { index } });
    }

    const plan = parsePlanText(VALID_PLAN, join(root, ".atelier", "PLAN.md"));
    const builder = new WorkingStateBuilder(provider, ledger);
    const state = await builder.build({ mode: "act", snapshot, plan, maximumRecentEvents: 5 });

    assert.deepEqual(state.taskDependencies.map((task) => task.id), ["blocked-dependency", "completed-dependency"]);
    assert.deepEqual(state.taskBlockers.map((task) => task.id), ["blocked-dependency"]);
    assert.equal(state.corrections.length, 1);
    assert.equal(state.manualEdits.length, 1);
    assert.equal(state.recentEvents.length, 5);
    assert.match(builder.toMarkdown(state), /## Manual Edits/);
    assert.match(builder.toMarkdown(state), /## Blockers/);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
