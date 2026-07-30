import { minimalEnvironment } from "../process/environment.ts";
import { runProcess } from "../process/async-process.ts";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProviderError } from "../domain/errors.ts";
import type {
  CreateTaskRequest,
  TaskPatch,
  TaskProviderCapabilities,
  TaskProviderStatus,
  TaskRecord,
  TaskStatus,
  TaskType,
} from "../domain/types.ts";
import type { TaskProvider } from "./task-provider.ts";

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function stringValue(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  const value = firstDefined(record, keys);
  return typeof value === "string" ? value : fallback;
}

function numberValue(record: Record<string, unknown>, keys: string[], fallback: number): number {
  const value = firstDefined(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      if (record === undefined) return undefined;
      return stringValue(record, ["id", "depends_on_id", "dependency_id", "issue_id"], "") || undefined;
    })
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeStatus(value: unknown): TaskStatus {
  const status = typeof value === "string" ? value.toLowerCase().replaceAll("-", "_") : "unknown";
  if (["open", "in_progress", "blocked", "closed", "deferred"].includes(status)) {
    return status as TaskStatus;
  }
  if (status === "done" || status === "complete" || status === "completed") return "closed";
  if (status === "progress") return "in_progress";
  return "unknown";
}

function normalizeType(value: unknown): TaskType {
  const type = typeof value === "string" ? value.toLowerCase() : "unknown";
  if (["bug", "feature", "task", "epic", "chore"].includes(type)) return type as TaskType;
  return "unknown";
}

function unwrapJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record === undefined) return [];
  for (const key of ["issues", "tasks", "results", "data", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  if (record.issue !== undefined) return [record.issue];
  if (record.task !== undefined) return [record.task];
  return [record];
}

function stablePlanTaskId(notes: string): string | undefined {
  const match = /(?:^|\n)Atelier plan task:\s*([^\s]+)\s*(?:\n|$)/.exec(notes);
  return match?.[1];
}

export function normalizeBeadsTask(value: unknown): TaskRecord {
  const record = asRecord(value);
  if (record === undefined) throw new ProviderError("Beads returned a non-object task", { value });
  const id = stringValue(record, ["id", "issue_id", "task_id"]);
  if (!id) throw new ProviderError("Beads task is missing an id", { value });

  const dependencyValue = firstDefined(record, [
    "dependencies",
    "dependency_ids",
    "depends_on",
    "blocked_by",
  ]);
  const acceptance = firstDefined(record, ["acceptance_criteria", "acceptance", "criteria"]);
  const labels = firstDefined(record, ["labels", "tags"]);
  const notes = stringValue(record, ["notes", "note"]);
  const planTaskId = stablePlanTaskId(notes);

  return {
    id,
    ...(planTaskId === undefined ? {} : { planTaskId }),
    title: stringValue(record, ["title", "name"], id),
    description: stringValue(record, ["description", "body"]),
    ...(stringValue(record, ["design"]) ? { design: stringValue(record, ["design"]) } : {}),
    ...(notes ? { notes } : {}),
    acceptanceCriteria:
      typeof acceptance === "string"
        ? acceptance.split("\n").map((line) => line.trim()).filter(Boolean)
        : stringArray(acceptance),
    status: normalizeStatus(firstDefined(record, ["status", "state"])),
    priority: numberValue(record, ["priority", "priority_level"], 2),
    type: normalizeType(firstDefined(record, ["issue_type", "type", "kind"])),
    dependencies: stringArray(dependencyValue),
    labels: stringArray(labels),
    ...(stringValue(record, ["assignee", "owner"]) ? { assignee: stringValue(record, ["assignee", "owner"]) } : {}),
    ...(stringValue(record, ["created_at", "createdAt"]) ? { createdAt: stringValue(record, ["created_at", "createdAt"]) } : {}),
    ...(stringValue(record, ["updated_at", "updatedAt"]) ? { updatedAt: stringValue(record, ["updated_at", "updatedAt"]) } : {}),
    raw: value,
  };
}

function parseJsonOutput(output: string, command: string[]): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined) continue;
      try {
        return JSON.parse(line) as unknown;
      } catch {
        // Continue looking for a final JSON line after warnings.
      }
    }
    throw new ProviderError("Beads did not return valid JSON", { command, output, error });
  }
}

export class BeadsCliTaskProvider implements TaskProvider {
  readonly name = "beads";
  private readonly cwd: string;
  private readonly executable: string;
  private readonly timeoutMs: number;

  constructor(options: { cwd: string; executable?: string; timeoutMs?: number }) {
    this.cwd = options.cwd;
    this.executable = options.executable ?? "bd";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async capabilities(): Promise<TaskProviderCapabilities> {
    return { stablePlanTaskIds: true, dependencyRemoval: true, retirement: true };
  }

  private async run(args: string[], options: { input?: string; allowFailure?: boolean; signal?: AbortSignal } = {}): Promise<CommandResult> {
    let result;
    try {
      result = await runProcess(this.executable, args, {
        cwd: this.cwd,
        environment: minimalEnvironment({ overrides: { BD_JSON_ENVELOPE: "1" } }),
        input: options.input,
        timeoutMs: this.timeoutMs,
        idleTimeoutMs: Math.min(this.timeoutMs, 15_000),
        signal: options.signal,
      });
    } catch (error) {
      if (options.allowFailure) return { stdout: "", stderr: error instanceof Error ? error.message : String(error), status: 127 };
      throw new ProviderError(`Unable to execute ${this.executable}`, { error, args });
    }
    const commandResult = { stdout: result.stdout, stderr: result.stderr, status: result.exitCode };
    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new ProviderError(`Beads command failed: ${this.executable} ${args.join(" ")}`, { ...commandResult, timedOut: result.timedOut, aborted: result.aborted });
    }
    return commandResult;
  }

  async status(): Promise<TaskProviderStatus> {
    const version = await this.run(["version"], { allowFailure: true });
    if (version.status !== 0) {
      return {
        provider: this.name,
        available: false,
        initialized: false,
        reason: version.stderr || `${this.executable} is unavailable`,
      };
    }

    const where = await this.run(["where", "--json"], { allowFailure: true });
    const list = where.status === 0
      ? await this.run(["list", "--json"], { allowFailure: true })
      : undefined;
    const initialized = where.status === 0 && list?.status === 0;
    return {
      provider: this.name,
      available: true,
      initialized,
      version: version.stdout.trim() || version.stderr.trim(),
      ...(initialized
        ? {}
        : {
            reason: list?.stderr.trim()
              || where.stderr.trim()
              || "Beads is not initialized in this repository",
          }),
    };
  }

  async initialize(options: { stealth?: boolean; quiet?: boolean } = {}): Promise<void> {
    this.secureWorkspaceDirectory();
    const before = await this.status();
    if (!before.available) throw new ProviderError(before.reason ?? "Beads is unavailable", { provider: this.name });
    if (before.initialized) return;
    const args = ["init"];
    if (options.quiet !== false) args.push("--quiet");
    if (options.stealth === true) args.push("--stealth");
    await this.run(args);
    this.secureWorkspaceDirectory();
  }

  private secureWorkspaceDirectory(): void {
    const directory = join(this.cwd, ".beads");
    if (process.platform !== "win32" && existsSync(directory)) chmodSync(directory, 0o700);
  }

  async ready(): Promise<TaskRecord[]> {
    const result = await this.run(["ready", "--json"]);
    return unwrapJson(parseJsonOutput(result.stdout, ["ready", "--json"])).map(normalizeBeadsTask);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.run(["show", taskId, "--json"], { allowFailure: true });
    if (result.status !== 0) return undefined;
    const items = unwrapJson(parseJsonOutput(result.stdout, ["show", taskId, "--json"]));
    return items.length === 0 ? undefined : normalizeBeadsTask(items[0]);
  }

  async list(): Promise<TaskRecord[]> {
    const result = await this.run(["list", "--json"]);
    return unwrapJson(parseJsonOutput(result.stdout, ["list", "--json"])).map(normalizeBeadsTask);
  }

  async create(request: CreateTaskRequest): Promise<TaskRecord> {
    const notes = [
      `Atelier plan task: ${request.planTaskId}`,
      request.notes,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n\n");
    const args = [
      "create",
      request.title,
      "--description",
      request.description,
      "--type",
      request.type === "unknown" ? "task" : request.type,
      "--priority",
      String(request.priority),
      "--acceptance",
      request.acceptanceCriteria.join("\n"),
      "--notes",
      notes,
      "--json",
    ];
    if (request.design) args.splice(args.length - 1, 0, "--design", request.design);
    if ((request.labels ?? []).length > 0) {
      args.splice(args.length - 1, 0, "--labels", (request.labels ?? []).join(","));
    }
    const result = await this.run(args);
    const items = unwrapJson(parseJsonOutput(result.stdout, args));
    if (items.length === 0) throw new ProviderError("Beads create returned no task", { result });
    const task = normalizeBeadsTask(items[0]);
    task.planTaskId = request.planTaskId;
    return task;
  }

  async update(taskId: string, patch: TaskPatch): Promise<TaskRecord> {
    const args = ["update", taskId];
    if (patch.title !== undefined) args.push("--title", patch.title);
    if (patch.description !== undefined) args.push("--description", patch.description);
    if (patch.design !== undefined) args.push("--design", patch.design);
    if (patch.notes !== undefined) args.push("--notes", patch.notes);
    if (patch.acceptanceCriteria !== undefined) args.push("--acceptance", patch.acceptanceCriteria.join("\n"));
    if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
    if (patch.type !== undefined && patch.type !== "unknown") args.push("--type", patch.type);
    if (patch.status !== undefined && patch.status !== "unknown") args.push("--status", patch.status);
    args.push("--json");
    const result = await this.run(args);
    const items = unwrapJson(parseJsonOutput(result.stdout, args));
    if (items.length > 0) return normalizeBeadsTask(items[0]);
    const task = await this.get(taskId);
    if (task === undefined) throw new ProviderError(`Beads task disappeared after update: ${taskId}`);
    return task;
  }

  async claim(taskId: string): Promise<TaskRecord> {
    const args = ["update", taskId, "--claim", "--json"];
    const result = await this.run(args);
    const items = unwrapJson(parseJsonOutput(result.stdout, args));
    if (items.length > 0) return normalizeBeadsTask(items[0]);
    const task = await this.get(taskId);
    if (task === undefined) throw new ProviderError(`Unable to read claimed task: ${taskId}`);
    return task;
  }

  async addDependency(
    taskId: string,
    dependencyTaskId: string,
    type: "blocks" | "related" | "parent-child" = "blocks",
  ): Promise<void> {
    await this.run(["dep", "add", taskId, dependencyTaskId, "--type", type, "--json"]);
  }

  async removeDependency(
    taskId: string,
    dependencyTaskId: string,
    _type: "blocks" | "related" | "parent-child" = "blocks",
  ): Promise<void> {
    await this.run(["dep", "remove", taskId, dependencyTaskId, "--json"]);
  }

  async close(taskId: string, reason: string): Promise<TaskRecord> {
    const args = ["close", taskId, "--reason", reason, "--json"];
    const result = await this.run(args);
    const items = unwrapJson(parseJsonOutput(result.stdout, args));
    if (items.length > 0) return normalizeBeadsTask(items[0]);
    const task = await this.get(taskId);
    if (task === undefined) throw new ProviderError(`Unable to read closed task: ${taskId}`);
    return task;
  }
}
