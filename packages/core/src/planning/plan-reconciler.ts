import type {
  CreateTaskRequest,
  ParsedPlan,
  PlanTask,
  ReconciliationFieldChange,
  ReconciliationOperation,
  ReconciliationOperationCheckpoint,
  TaskPatch,
  TaskProviderIdentity,
  TaskReconciliation,
  TaskRecord,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";
import { sha256 } from "../util/hash.ts";
import { nowIso } from "../util/ids.ts";

function taskDescription(task: PlanTask): string {
  const sections = [
    task.description || task.goal,
    task.scope.length > 0 ? `In scope:\n${task.scope.map((item) => `- ${item}`).join("\n")}` : "",
    task.outOfScope.length > 0
      ? `Out of scope:\n${task.outOfScope.map((item) => `- ${item}`).join("\n")}`
      : "",
  ].filter(Boolean);
  return sections.join("\n\n");
}

function taskDesign(task: PlanTask): string | undefined {
  return task.notes.length === 0 ? undefined : task.notes.join("\n");
}

function createRequest(task: PlanTask): CreateTaskRequest {
  const design = taskDesign(task);
  return {
    planTaskId: task.id,
    title: task.title,
    description: taskDescription(task),
    ...(design === undefined ? {} : { design }),
    acceptanceCriteria: [...task.completionCriteria, ...task.validation.map((item) => `Validation: ${item}`)],
    priority: task.priority,
    type: task.type,
    labels: ["atelier-plan"],
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function patchFor(task: PlanTask, existing: TaskRecord): TaskPatch {
  const patch: TaskPatch = {};
  const description = taskDescription(task);
  const design = taskDesign(task);
  const acceptanceCriteria = [...task.completionCriteria, ...task.validation.map((item) => `Validation: ${item}`)];
  if (existing.title !== task.title) patch.title = task.title;
  if (existing.description !== description) patch.description = description;
  if ((existing.design ?? "") !== (design ?? "")) patch.design = design ?? "";
  if (!arraysEqual(existing.acceptanceCriteria, acceptanceCriteria)) patch.acceptanceCriteria = acceptanceCriteria;
  if (existing.priority !== task.priority) patch.priority = task.priority;
  if (existing.type !== task.type && task.type !== "unknown") patch.type = task.type;
  return patch;
}

function changesFor(existing: TaskRecord, patch: TaskPatch): ReconciliationFieldChange[] {
  return (Object.keys(patch) as Array<keyof TaskPatch>).sort().map((field) => ({
    field,
    before: existing[field],
    after: patch[field],
  }));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

type RawOperation = { kind: ReconciliationOperation["kind"]; planTaskId: string } & Record<string, unknown>;

function withOperationId(operation: RawOperation, provider: TaskProviderIdentity): ReconciliationOperation {
  return {
    ...operation,
    operationId: digest({ provider, operation }),
  } as ReconciliationOperation;
}

const KIND_ORDER: Record<ReconciliationOperation["kind"], number> = {
  adopt: 0,
  create: 1,
  update: 2,
  unlink: 3,
  link: 4,
  retire: 5,
  conflict: 6,
};

function operationSort(planOrder: Map<string, number>): (left: ReconciliationOperation, right: ReconciliationOperation) => number {
  return (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || (planOrder.get(left.planTaskId) ?? Number.MAX_SAFE_INTEGER)
      - (planOrder.get(right.planTaskId) ?? Number.MAX_SAFE_INTEGER)
    || left.planTaskId.localeCompare(right.planTaskId)
    || left.operationId.localeCompare(right.operationId);
}

function identity(name: string, version: string | undefined): TaskProviderIdentity {
  return { name, ...(version === undefined ? {} : { version }) };
}

function sameIdentity(left: TaskProviderIdentity, right: TaskProviderIdentity): boolean {
  return left.name === right.name && left.version === right.version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PlanReconciler {
  private readonly provider: TaskProvider;
  private readonly ledger: SqliteLedger;

  constructor(provider: TaskProvider, ledger: SqliteLedger) {
    this.provider = provider;
    this.ledger = ledger;
  }

  async preview(plan: ParsedPlan): Promise<TaskReconciliation> {
    const status = await this.provider.status();
    const provider = identity(this.provider.name, status.version);
    const capabilities = await this.provider.capabilities();
    const raw: RawOperation[] = [];
    const conflicts: string[] = [];
    const unchanged: string[] = [];
    const planOrder = new Map(plan.tasks.map((task, index) => [task.id, index]));
    const planIds = new Set(plan.tasks.map((task) => task.id));
    const mappings = this.ledger.listTaskMappings();
    const mappingByPlan = new Map(mappings.map((mapping) => [mapping.planTaskId, mapping]));

    const addConflict = (planTaskId: string, reason: string): void => {
      if (conflicts.includes(reason)) return;
      conflicts.push(reason);
      raw.push({ kind: "conflict", planTaskId, reason });
    };

    if (!status.available || !status.initialized) {
      addConflict("plan", `Task provider ${this.provider.name} is unavailable or uninitialized${status.reason ? `: ${status.reason}` : "."}`);
    }
    for (const diagnostic of plan.diagnostics.filter((item) => item.level === "error")) {
      addConflict(diagnostic.taskId ?? "plan", `Plan validation error: ${diagnostic.message}`);
    }
    if (conflicts.length > 0) return this.result(plan.hash, provider, raw, unchanged, conflicts, planOrder);

    const providerTasks = (await this.provider.list()).sort((left, right) => left.id.localeCompare(right.id));
    const byId = new Map(providerTasks.map((task) => [task.id, task]));
    const byPlanId = new Map<string, TaskRecord[]>();
    for (const task of providerTasks) {
      if (task.planTaskId === undefined) continue;
      const matches = byPlanId.get(task.planTaskId) ?? [];
      matches.push(task);
      byPlanId.set(task.planTaskId, matches);
    }
    const resolved = new Map<string, TaskRecord>();
    const createdPlanIds = new Set<string>();

    for (const task of plan.tasks) {
      const mapping = mappingByPlan.get(task.id);
      const markerMatches = byPlanId.get(task.id) ?? [];
      if (capabilities.stablePlanTaskIds && markerMatches.length > 1) {
        addConflict(task.id, `Task ${task.id} matches multiple provider tasks: ${markerMatches.map((item) => item.id).join(", ")}.`);
        continue;
      }
      let existing: TaskRecord | undefined;
      let adopted = false;
      if (mapping !== undefined) {
        if (mapping.provider !== this.provider.name) {
          addConflict(task.id, `Task ${task.id} is mapped to provider ${mapping.provider}, not ${this.provider.name}.`);
          continue;
        }
        existing = byId.get(mapping.providerTaskId);
        if (existing === undefined) {
          addConflict(task.id, `Mapped provider task ${mapping.providerTaskId} for ${task.id} no longer exists.`);
          continue;
        }
        if (existing.planTaskId !== undefined && existing.planTaskId !== task.id) {
          addConflict(task.id, `Mapped provider task ${existing.id} for ${task.id} carries stable plan id ${existing.planTaskId}.`);
          continue;
        }
      } else {
        if (!capabilities.stablePlanTaskIds) {
          addConflict(task.id, `Provider ${this.provider.name} cannot safely create ${task.id} because stable plan task ids are unsupported.`);
          continue;
        }
        existing = markerMatches[0];
        if (existing === undefined) {
          raw.push({ kind: "create", planTaskId: task.id, request: createRequest(task) });
          createdPlanIds.add(task.id);
          continue;
        }
        adopted = true;
        raw.push({ kind: "adopt", planTaskId: task.id, providerTaskId: existing.id });
      }

      if (existing.status === "closed" || existing.status === "deferred") {
        if (!adopted && mapping?.planHash === plan.hash) {
          resolved.set(task.id, existing);
          continue;
        }
        addConflict(task.id, `Provider task ${existing.id} for active plan task ${task.id} has unexpected status ${existing.status}.`);
        continue;
      }
      resolved.set(task.id, existing);
      const patch = patchFor(task, existing);
      if (Object.keys(patch).length > 0) {
        if (!adopted && mapping?.planHash === plan.hash) {
          addConflict(task.id, `Provider task ${existing.id} changed unexpectedly after plan ${plan.hash} was reconciled.`);
          continue;
        }
        raw.push({
          kind: "update",
          planTaskId: task.id,
          providerTaskId: existing.id,
          patch,
          changes: changesFor(existing, patch),
        });
      }
    }

    for (const mapping of mappings) {
      if (mapping.provider !== this.provider.name || planIds.has(mapping.planTaskId)) continue;
      const existing = byId.get(mapping.providerTaskId);
      if (existing === undefined) {
        addConflict(mapping.planTaskId, `Mapped provider task ${mapping.providerTaskId} for removed plan task ${mapping.planTaskId} no longer exists.`);
      } else if (existing.status !== "closed" && existing.status !== "deferred") {
        if (!capabilities.retirement) {
          addConflict(mapping.planTaskId, `Provider ${this.provider.name} cannot retire removed plan task ${mapping.planTaskId}.`);
        } else {
          raw.push({ kind: "retire", planTaskId: mapping.planTaskId, providerTaskId: existing.id });
        }
      }
    }

    for (const task of plan.tasks) {
      if (raw.some((operation) => operation.kind === "conflict" && operation.planTaskId === task.id)) continue;
      const existing = resolved.get(task.id);
      const desired = new Set(task.dependencies);
      const mapping = mappingByPlan.get(task.id);
      if (existing !== undefined && mapping?.planHash === plan.hash) {
        const currentManaged = new Set(existing.dependencies.map((dependencyProviderTaskId) =>
          mappings.find((candidate) => candidate.provider === this.provider.name
            && candidate.providerTaskId === dependencyProviderTaskId)?.planTaskId
            ?? byId.get(dependencyProviderTaskId)?.planTaskId,
        ).filter((item): item is string => item !== undefined));
        if (currentManaged.size !== desired.size || [...desired].some((item) => !currentManaged.has(item))) {
          addConflict(task.id, `Provider dependencies for ${task.id} changed unexpectedly after plan ${plan.hash} was reconciled.`);
          continue;
        }
      }
      for (const dependencyPlanTaskId of task.dependencies) {
        const dependency = resolved.get(dependencyPlanTaskId);
        if (createdPlanIds.has(task.id) || existing === undefined || dependency === undefined
          || !existing.dependencies.includes(dependency.id)) {
          raw.push({
            kind: "link",
            planTaskId: task.id,
            ...(existing === undefined ? {} : { providerTaskId: existing.id }),
            dependencyPlanTaskId,
            ...(dependency === undefined ? {} : { dependencyProviderTaskId: dependency.id }),
          });
        }
      }
      if (existing === undefined) continue;
      for (const dependencyProviderTaskId of existing.dependencies) {
        const dependencyMapping = mappings.find((mapping) => mapping.provider === this.provider.name
          && mapping.providerTaskId === dependencyProviderTaskId);
        const dependencyPlanTaskId = dependencyMapping?.planTaskId
          ?? byId.get(dependencyProviderTaskId)?.planTaskId;
        if (dependencyPlanTaskId === undefined || desired.has(dependencyPlanTaskId)) continue;
        if (!capabilities.dependencyRemoval) {
          addConflict(task.id, `Provider ${this.provider.name} cannot remove dependency ${dependencyPlanTaskId} from ${task.id}.`);
        } else {
          raw.push({
            kind: "unlink",
            planTaskId: task.id,
            providerTaskId: existing.id,
            dependencyPlanTaskId,
            dependencyProviderTaskId,
          });
        }
      }
    }

    for (const task of plan.tasks) {
      if (!raw.some((operation) => operation.planTaskId === task.id)) unchanged.push(task.id);
    }
    return this.result(plan.hash, provider, raw, unchanged, conflicts, planOrder);
  }

  async apply(plan: ParsedPlan, approved?: TaskReconciliation): Promise<TaskReconciliation> {
    const latest = await this.preview(plan);
    const reconciliation = approved ?? latest;
    if (approved !== undefined && approved.digest !== latest.digest) {
      const reason = "Provider or plan state changed after the reconciliation preview; preview again before applying.";
      return this.withConflict(reconciliation, reason);
    }
    if (reconciliation.conflicts.length > 0) return reconciliation;

    const status = await this.provider.status();
    const currentIdentity = identity(this.provider.name, status.version);
    if (!sameIdentity(currentIdentity, reconciliation.provider)) {
      return this.withConflict(reconciliation, "Task provider identity changed after preview; preview again before applying.");
    }

    const created: Array<{ planTaskId: string; providerTaskId: string }> = [];
    for (const operation of reconciliation.operations) {
      if (operation.kind === "conflict") continue;
      this.checkpoint(reconciliation, operation.operationId, "started");
      try {
        await this.applyOperation(plan, reconciliation, operation, created);
        this.checkpoint(reconciliation, operation.operationId, "completed");
      } catch (error) {
        this.checkpoint(reconciliation, operation.operationId, "failed", errorMessage(error));
        throw error;
      }
    }

    for (const task of plan.tasks) {
      const mapping = this.ledger.getTaskMapping(task.id);
      if (mapping === undefined || mapping.provider !== this.provider.name) {
        throw new Error(`Reconciliation completed without a provider mapping for ${task.id}.`);
      }
      this.ledger.setTaskMapping(task.id, this.provider.name, mapping.providerTaskId, plan.hash);
    }

    this.ledger.setState("lastReconciledPlanHash", plan.hash);
    this.ledger.append({
      kind: "plan.reconciled",
      actor: "system",
      payload: {
        planHash: plan.hash,
        provider: reconciliation.provider,
        reconciliationDigest: reconciliation.digest,
        created,
        operationCount: reconciliation.operations.length,
      },
    });
    return { ...reconciliation, created, applied: true };
  }

  private result(
    planHash: string,
    provider: TaskProviderIdentity,
    raw: RawOperation[],
    unchanged: string[],
    conflicts: string[],
    planOrder: Map<string, number>,
  ): TaskReconciliation {
    const operations = raw.map((operation) => withOperationId(operation, provider)).sort(operationSort(planOrder));
    return {
      planHash,
      provider,
      digest: digest({ planHash, provider, operations }),
      operations,
      unchanged,
      created: [],
      applied: false,
      conflicts,
    };
  }

  private withConflict(reconciliation: TaskReconciliation, reason: string): TaskReconciliation {
    const operation = withOperationId({ kind: "conflict", planTaskId: "plan", reason }, reconciliation.provider);
    const operations = [...reconciliation.operations, operation];
    return {
      ...reconciliation,
      digest: digest({ planHash: reconciliation.planHash, provider: reconciliation.provider, operations }),
      operations,
      applied: false,
      conflicts: [...reconciliation.conflicts, reason],
    };
  }

  private checkpoint(
    reconciliation: TaskReconciliation,
    operationId: string,
    status: ReconciliationOperationCheckpoint["status"],
    error?: string,
  ): void {
    this.ledger.saveReconciliationCheckpoint({
      reconciliationDigest: reconciliation.digest,
      operationId,
      provider: reconciliation.provider,
      planHash: reconciliation.planHash,
      status,
      ...(error === undefined ? {} : { error }),
      updatedAt: nowIso(),
    });
  }

  private async applyOperation(
    plan: ParsedPlan,
    reconciliation: TaskReconciliation,
    operation: Exclude<ReconciliationOperation, { kind: "conflict" }>,
    created: Array<{ planTaskId: string; providerTaskId: string }>,
  ): Promise<void> {
    if (operation.kind === "create") {
      const mapped = this.ledger.getTaskMapping(operation.planTaskId);
      if (mapped !== undefined) return;
      const matches = (await this.provider.list()).filter((task) => task.planTaskId === operation.planTaskId);
      if (matches.length > 1) throw new Error(`Task ${operation.planTaskId} matches multiple provider tasks during create recovery.`);
      let task = matches[0];
      if (task === undefined) {
        task = await this.provider.create(operation.request);
        created.push({ planTaskId: operation.planTaskId, providerTaskId: task.id });
      }
      this.assertStableMarker(task, operation.planTaskId, true);
      this.ledger.setTaskMapping(operation.planTaskId, this.provider.name, task.id, plan.hash);
      this.ledger.append({
        kind: matches.length === 0 ? "task.created" : "task.adopted",
        actor: "system",
        taskId: task.id,
        payload: { planTaskId: operation.planTaskId, provider: reconciliation.provider, planHash: plan.hash },
      });
      return;
    }

    if (operation.kind === "adopt") {
      const task = await this.requiredTask(operation.providerTaskId, operation.planTaskId, true, true);
      this.ledger.setTaskMapping(operation.planTaskId, this.provider.name, task.id, plan.hash);
      this.ledger.append({
        kind: "task.adopted",
        actor: "system",
        taskId: task.id,
        payload: { planTaskId: operation.planTaskId, provider: reconciliation.provider, planHash: plan.hash },
      });
      return;
    }

    if (operation.kind === "update") {
      const current = await this.requiredTask(operation.providerTaskId, operation.planTaskId);
      const planTask = plan.tasks.find((task) => task.id === operation.planTaskId);
      if (planTask === undefined) throw new Error(`Plan task ${operation.planTaskId} disappeared during update.`);
      const patch = patchFor(planTask, current);
      if (Object.keys(patch).length > 0) await this.provider.update(current.id, patch);
      this.ledger.setTaskMapping(operation.planTaskId, this.provider.name, current.id, plan.hash);
      this.ledger.append({
        kind: "task.updated",
        actor: "system",
        taskId: current.id,
        payload: { planTaskId: operation.planTaskId, patch, planHash: plan.hash },
      });
      return;
    }

    if (operation.kind === "link" || operation.kind === "unlink") {
      const taskId = this.providerTaskId(operation.planTaskId, operation.providerTaskId);
      const dependencyTaskId = this.providerTaskId(operation.dependencyPlanTaskId, operation.dependencyProviderTaskId);
      const current = await this.requiredTask(taskId, operation.planTaskId);
      const linked = current.dependencies.includes(dependencyTaskId);
      if (operation.kind === "link" && !linked) await this.provider.addDependency(taskId, dependencyTaskId, "blocks");
      if (operation.kind === "unlink" && linked) await this.provider.removeDependency(taskId, dependencyTaskId, "blocks");
      this.ledger.append({
        kind: operation.kind === "link" ? "task.linked" : "task.unlinked",
        actor: "system",
        taskId,
        payload: {
          planTaskId: operation.planTaskId,
          dependencyPlanTaskId: operation.dependencyPlanTaskId,
          dependencyProviderTaskId: dependencyTaskId,
          type: "blocks",
          planHash: plan.hash,
        },
      });
      return;
    }

    const current = await this.requiredTask(operation.providerTaskId, operation.planTaskId, false);
    if (current.status !== "closed" && current.status !== "deferred") {
      await this.provider.close(current.id, `Removed from reviewed Atelier plan ${plan.hash}`);
    }
    this.ledger.append({
      kind: "task.retired",
      actor: "system",
      taskId: current.id,
      payload: { planTaskId: operation.planTaskId, planHash: plan.hash },
    });
  }

  private providerTaskId(planTaskId: string, supplied: string | undefined): string {
    const taskId = supplied ?? this.ledger.getTaskMapping(planTaskId)?.providerTaskId;
    if (taskId === undefined) throw new Error(`No provider task mapping exists for ${planTaskId}.`);
    return taskId;
  }

  private async requiredTask(
    providerTaskId: string,
    planTaskId: string,
    requireMarker = true,
    requireExactMarker = false,
  ): Promise<TaskRecord> {
    const task = await this.provider.get(providerTaskId);
    if (task === undefined) throw new Error(`Provider task ${providerTaskId} for ${planTaskId} disappeared during reconciliation.`);
    if (requireMarker) this.assertStableMarker(task, planTaskId, requireExactMarker);
    return task;
  }

  private assertStableMarker(task: TaskRecord, planTaskId: string, requireExact = false): void {
    if ((requireExact && task.planTaskId !== planTaskId)
      || (task.planTaskId !== undefined && task.planTaskId !== planTaskId)) {
      throw new Error(`Provider task ${task.id} carries stable plan id ${task.planTaskId ?? "none"}, not ${planTaskId}.`);
    }
  }
}
