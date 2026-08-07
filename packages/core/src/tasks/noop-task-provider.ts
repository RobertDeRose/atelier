import { ProviderError } from "../domain/errors.ts";
import type {
  CreateTaskRequest,
  TaskPatch,
  TaskProviderCapabilities,
  TaskProviderStatus,
  TaskRecord,
} from "../domain/types.ts";
import type { TaskProvider } from "./task-provider.ts";

/**
 * Explicitly disabled task tracking. Read-only queries return no work; mutations
 * fail instead of silently creating transient state.
 */
export class NoopTaskProvider implements TaskProvider {
  readonly name = "none";

  async capabilities(): Promise<TaskProviderCapabilities> {
    return { stablePlanTaskIds: false, dependencyRemoval: false, retirement: false };
  }

  peekStatus(): TaskProviderStatus {
    return {
      provider: this.name,
      available: true,
      initialized: true,
      reason: "Persistent task tracking is disabled by configuration.",
    };
  }

  peekTask(_taskId: string): TaskRecord | undefined {
    return undefined;
  }

  peekReady(): TaskRecord[] {
    return [];
  }

  async status(): Promise<TaskProviderStatus> {
    return {
      provider: this.name,
      available: true,
      initialized: true,
      reason: "Persistent task tracking is disabled by configuration.",
    };
  }

  async initialize(): Promise<void> {}

  async ready(): Promise<TaskRecord[]> {
    return [];
  }

  async get(_taskId: string): Promise<TaskRecord | undefined> {
    return undefined;
  }

  async list(): Promise<TaskRecord[]> {
    return [];
  }

  async create(_request: CreateTaskRequest): Promise<TaskRecord> {
    throw this.disabled();
  }

  async update(_taskId: string, _patch: TaskPatch): Promise<TaskRecord> {
    throw this.disabled();
  }

  async claim(_taskId: string): Promise<TaskRecord> {
    throw this.disabled();
  }

  async addDependency(
    _taskId: string,
    _dependencyTaskId: string,
    _type: "blocks" | "related" | "parent-child" = "blocks",
  ): Promise<void> {
    throw this.disabled();
  }

  async removeDependency(
    _taskId: string,
    _dependencyTaskId: string,
    _type: "blocks" | "related" | "parent-child" = "blocks",
  ): Promise<void> {
    throw this.disabled();
  }

  async close(_taskId: string, _reason: string): Promise<TaskRecord> {
    throw this.disabled();
  }

  private disabled(): ProviderError {
    return new ProviderError("Persistent task tracking is disabled for this repository.");
  }
}
