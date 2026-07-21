import type {
  CreateTaskRequest,
  TaskPatch,
  TaskProviderStatus,
  TaskRecord,
} from "../domain/types.ts";

export interface TaskProvider {
  readonly name: string;
  status(): Promise<TaskProviderStatus>;
  initialize(options?: { stealth?: boolean; quiet?: boolean }): Promise<void>;
  ready(): Promise<TaskRecord[]>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  create(request: CreateTaskRequest): Promise<TaskRecord>;
  update(taskId: string, patch: TaskPatch): Promise<TaskRecord>;
  claim(taskId: string): Promise<TaskRecord>;
  addDependency(taskId: string, dependencyTaskId: string, type?: "blocks" | "related" | "parent-child"): Promise<void>;
  close(taskId: string, reason: string): Promise<TaskRecord>;
}
