import type {
  CreateTaskRequest,
  TaskPatch,
  TaskProviderStatus,
  TaskRecord,
} from "../domain/types.ts";
import { newId, nowIso } from "../util/ids.ts";
import type { TaskProvider } from "./task-provider.ts";

function cloneTask(task: TaskRecord): TaskRecord {
  return structuredClone(task);
}

export class InMemoryTaskProvider implements TaskProvider {
  readonly name = "memory";
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(initialTasks: TaskRecord[] = []) {
    for (const task of initialTasks) this.tasks.set(task.id, cloneTask(task));
  }

  async status(): Promise<TaskProviderStatus> {
    return { provider: this.name, available: true, initialized: true, version: "1" };
  }

  async initialize(): Promise<void> {}

  async ready(): Promise<TaskRecord[]> {
    const closed = new Set(
      [...this.tasks.values()].filter((task) => task.status === "closed").map((task) => task.id),
    );
    return [...this.tasks.values()]
      .filter((task) => task.status === "open" || task.status === "in_progress")
      .filter((task) => task.dependencies.every((dependency) => closed.has(dependency)))
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map(cloneTask);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : cloneTask(task);
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneTask);
  }

  async create(request: CreateTaskRequest): Promise<TaskRecord> {
    const id = newId("task");
    const timestamp = nowIso();
    const task: TaskRecord = {
      id,
      planTaskId: request.planTaskId,
      title: request.title,
      description: request.description,
      ...(request.design === undefined ? {} : { design: request.design }),
      ...(request.notes === undefined ? {} : { notes: request.notes }),
      acceptanceCriteria: [...request.acceptanceCriteria],
      status: "open",
      priority: request.priority,
      type: request.type,
      dependencies: [],
      labels: [...(request.labels ?? [])],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tasks.set(id, task);
    return cloneTask(task);
  }

  async update(taskId: string, patch: TaskPatch): Promise<TaskRecord> {
    const current = this.tasks.get(taskId);
    if (current === undefined) throw new Error(`Unknown task: ${taskId}`);
    const next: TaskRecord = {
      ...current,
      ...patch,
      acceptanceCriteria: patch.acceptanceCriteria ?? current.acceptanceCriteria,
      updatedAt: nowIso(),
    };
    this.tasks.set(taskId, next);
    return cloneTask(next);
  }

  async claim(taskId: string): Promise<TaskRecord> {
    return this.update(taskId, { status: "in_progress" });
  }

  async addDependency(taskId: string, dependencyTaskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    if (!this.tasks.has(dependencyTaskId)) throw new Error(`Unknown dependency: ${dependencyTaskId}`);
    if (!task.dependencies.includes(dependencyTaskId)) {
      task.dependencies.push(dependencyTaskId);
      task.updatedAt = nowIso();
    }
  }

  async close(taskId: string, reason: string): Promise<TaskRecord> {
    const task = await this.update(taskId, {
      status: "closed",
      notes: [this.tasks.get(taskId)?.notes, `Closed: ${reason}`].filter(Boolean).join("\n"),
    });
    return task;
  }
}
