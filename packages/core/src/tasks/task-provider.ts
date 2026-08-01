import type {
  CreateTaskRequest,
  TaskPatch,
  TaskProviderCapabilities,
  TaskProviderStatus,
  TaskRecord,
} from "../domain/types.ts";

export interface TaskProvider {
  readonly name: string;
  capabilities(): Promise<TaskProviderCapabilities>;
  /** Return the latest status without performing provider I/O. */
  peekStatus?(): TaskProviderStatus | undefined;
  /** Return a cached task without performing provider I/O. */
  peekTask?(taskId: string): TaskRecord | undefined;
  status(): Promise<TaskProviderStatus>;
  initialize(options?: { stealth?: boolean; quiet?: boolean }): Promise<void>;
  ready(): Promise<TaskRecord[]>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  create(request: CreateTaskRequest): Promise<TaskRecord>;
  update(taskId: string, patch: TaskPatch): Promise<TaskRecord>;
  claim(taskId: string): Promise<TaskRecord>;
  addDependency(taskId: string, dependencyTaskId: string, type?: "blocks" | "related" | "parent-child"): Promise<void>;
  removeDependency(taskId: string, dependencyTaskId: string, type?: "blocks" | "related" | "parent-child"): Promise<void>;
  close(taskId: string, reason: string): Promise<TaskRecord>;
}
