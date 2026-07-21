import type {
  CreateTaskRequest,
  ParsedPlan,
  PlanTask,
  ReconciliationOperation,
  TaskPatch,
  TaskReconciliation,
  TaskRecord,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";

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

function hasPatch(patch: TaskPatch): boolean {
  return Object.keys(patch).length > 0;
}

export class PlanReconciler {
  private readonly provider: TaskProvider;
  private readonly ledger: SqliteLedger;

  constructor(provider: TaskProvider, ledger: SqliteLedger) {
    this.provider = provider;
    this.ledger = ledger;
  }

  async preview(plan: ParsedPlan): Promise<TaskReconciliation> {
    const operations: ReconciliationOperation[] = [];
    const conflicts: string[] = [];
    const resolved = new Map<string, string>();

    for (const task of plan.tasks) {
      const mapping = this.ledger.getTaskMapping(task.id);
      if (mapping === undefined) {
        operations.push({ kind: "create", planTaskId: task.id, request: createRequest(task) });
        continue;
      }
      if (mapping.provider !== this.provider.name) {
        const reason = `Task ${task.id} is mapped to provider ${mapping.provider}, not ${this.provider.name}.`;
        conflicts.push(reason);
        operations.push({ kind: "conflict", planTaskId: task.id, reason });
        continue;
      }
      const existing = await this.provider.get(mapping.providerTaskId);
      if (existing === undefined) {
        const reason = `Mapped provider task ${mapping.providerTaskId} for ${task.id} no longer exists.`;
        conflicts.push(reason);
        operations.push({ kind: "conflict", planTaskId: task.id, reason });
        continue;
      }
      resolved.set(task.id, existing.id);
      const patch = patchFor(task, existing);
      if (hasPatch(patch)) {
        operations.push({
          kind: "update",
          planTaskId: task.id,
          providerTaskId: existing.id,
          patch,
        });
      }
    }

    for (const task of plan.tasks) {
      const mapping = this.ledger.getTaskMapping(task.id);
      const providerTaskId = mapping?.provider === this.provider.name ? mapping.providerTaskId : resolved.get(task.id);
      if (providerTaskId === undefined) continue;
      const existing = await this.provider.get(providerTaskId);
      if (existing === undefined) continue;
      for (const dependencyPlanTaskId of task.dependencies) {
        const dependencyMapping = this.ledger.getTaskMapping(dependencyPlanTaskId);
        if (dependencyMapping === undefined || dependencyMapping.provider !== this.provider.name) continue;
        if (!existing.dependencies.includes(dependencyMapping.providerTaskId)) {
          operations.push({
            kind: "link",
            planTaskId: task.id,
            providerTaskId,
            dependencyPlanTaskId,
            dependencyProviderTaskId: dependencyMapping.providerTaskId,
          });
        }
      }
    }

    return { planHash: plan.hash, operations, created: [], applied: false, conflicts };
  }

  async apply(plan: ParsedPlan, preview?: TaskReconciliation): Promise<TaskReconciliation> {
    const reconciliation = preview ?? (await this.preview(plan));
    if (plan.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      return {
        ...reconciliation,
        conflicts: [
          ...reconciliation.conflicts,
          "Plan contains validation errors and cannot be reconciled.",
        ],
      };
    }
    if (reconciliation.conflicts.length > 0) return reconciliation;

    const created: Array<{ planTaskId: string; providerTaskId: string }> = [];
    const newMappings = new Map<string, string>();

    for (const operation of reconciliation.operations) {
      if (operation.kind !== "create") continue;
      const task = await this.provider.create(operation.request);
      this.ledger.setTaskMapping(operation.planTaskId, this.provider.name, task.id, plan.hash);
      newMappings.set(operation.planTaskId, task.id);
      created.push({ planTaskId: operation.planTaskId, providerTaskId: task.id });
      this.ledger.append({
        kind: "task.created",
        actor: "system",
        taskId: task.id,
        payload: { planTaskId: operation.planTaskId, provider: this.provider.name, planHash: plan.hash },
      });
    }

    for (const operation of reconciliation.operations) {
      if (operation.kind !== "update") continue;
      await this.provider.update(operation.providerTaskId, operation.patch);
      this.ledger.setTaskMapping(operation.planTaskId, this.provider.name, operation.providerTaskId, plan.hash);
      this.ledger.append({
        kind: "task.updated",
        actor: "system",
        taskId: operation.providerTaskId,
        payload: { planTaskId: operation.planTaskId, patch: operation.patch, planHash: plan.hash },
      });
    }

    for (const planTask of plan.tasks) {
      const taskMapping = this.ledger.getTaskMapping(planTask.id);
      const providerTaskId = newMappings.get(planTask.id) ?? taskMapping?.providerTaskId;
      if (providerTaskId === undefined) continue;
      const current = await this.provider.get(providerTaskId);
      const currentDependencies = new Set(current?.dependencies ?? []);
      for (const dependencyPlanTaskId of planTask.dependencies) {
        const dependencyMapping = this.ledger.getTaskMapping(dependencyPlanTaskId);
        const dependencyProviderTaskId = newMappings.get(dependencyPlanTaskId) ?? dependencyMapping?.providerTaskId;
        if (dependencyProviderTaskId === undefined || currentDependencies.has(dependencyProviderTaskId)) continue;
        await this.provider.addDependency(providerTaskId, dependencyProviderTaskId, "blocks");
        currentDependencies.add(dependencyProviderTaskId);
        this.ledger.append({
          kind: "task.linked",
          actor: "system",
          taskId: providerTaskId,
          payload: {
            planTaskId: planTask.id,
            dependencyPlanTaskId,
            dependencyProviderTaskId,
            type: "blocks",
            planHash: plan.hash,
          },
        });
      }
    }

    this.ledger.setState("lastReconciledPlanHash", plan.hash);
    this.ledger.append({
      kind: "plan.reconciled",
      actor: "system",
      payload: {
        planHash: plan.hash,
        provider: this.provider.name,
        created,
        operationCount: reconciliation.operations.length,
      },
    });
    return { ...reconciliation, created, applied: true };
  }
}
