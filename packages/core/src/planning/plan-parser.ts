import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedPlan, PlanDiagnostic, PlanTask, TaskExecutionContract, TaskType } from "../domain/types.ts";
import { sha256 } from "../util/hash.ts";

interface MutableTask {
  id: string;
  title: string;
  priority: number;
  type: TaskType;
  execution?: TaskExecutionContract;
  sections: Map<string, string[]>;
  startLine: number;
  endLine: number;
}

const SECTION_ALIASES: Record<string, string> = {
  goal: "goal",
  description: "description",
  scope: "scope",
  "in scope": "scope",
  "out of scope": "outOfScope",
  exclusions: "outOfScope",
  dependencies: "dependencies",
  "depends on": "dependencies",
  blockers: "dependencies",
  validation: "validation",
  tests: "validation",
  "completion criteria": "completionCriteria",
  acceptance: "completionCriteria",
  "acceptance criteria": "completionCriteria",
  notes: "notes",
  design: "notes",
};

function normalizeSection(value: string): string {
  return value.trim().toLowerCase().replace(/[:#]+$/g, "");
}

function parseTaskHeading(line: string): { id: string; title: string } | undefined {
  const bracket = /^##\s+\[([^\]]+)]\s+(.+?)\s*$/.exec(line);
  if (bracket?.[1] && bracket[2]) return { id: bracket[1].trim(), title: bracket[2].trim() };

  const separator = /^##\s+([A-Za-z][A-Za-z0-9._-]*)\s*(?:—|--|:|-)\s*(.+?)\s*$/.exec(line);
  if (separator?.[1] && separator[2]) return { id: separator[1].trim(), title: separator[2].trim() };
  return undefined;
}

function parseTaskMetadata(line: string): Record<string, unknown> | undefined {
  const match = /^\s*<!--\s*atlr:task\s+(.+?)\s*-->\s*$/.exec(line);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return { __invalid: true };
  }
}

function cleanLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<!--"));
}

function bulletValues(lines: string[]): string[] {
  return cleanLines(lines)
    .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^none\.?$/i.test(line));
}

function prose(lines: string[]): string {
  return cleanLines(lines)
    .map((line) => line.replace(/^[-*+]\s+/, "").trim())
    .join("\n")
    .trim();
}

function metadataTaskType(value: unknown): TaskType {
  if (typeof value !== "string") return "task";
  const normalized = value.toLowerCase();
  return ["bug", "feature", "task", "epic", "chore"].includes(normalized)
    ? (normalized as TaskType)
    : "unknown";
}


function metadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) return undefined;
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function repositoryRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function metadataExecution(value: unknown): TaskExecutionContract | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const writePaths = metadataStringArray(record.writePaths);
  const validations = metadataStringArray(record.validations);
  if (writePaths === undefined || writePaths.length === 0 || validations === undefined) return undefined;
  if (writePaths.some((path) => !repositoryRelativePath(path))) return undefined;
  for (const field of ["allowDependencyChanges", "allowFullSuite", "allowLocalChange"] as const) {
    if (typeof record[field] !== "boolean") return undefined;
  }
  return {
    writePaths,
    allowDependencyChanges: record.allowDependencyChanges as boolean,
    validations,
    allowFullSuite: record.allowFullSuite as boolean,
    allowLocalChange: record.allowLocalChange as boolean,
  };
}

function metadataPriority(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) return value;
  if (typeof value === "string" && /^[0-4]$/.test(value)) return Number(value);
  return 2;
}

function section(task: MutableTask, key: string): string[] {
  return task.sections.get(key) ?? [];
}

function finalizeTask(task: MutableTask): PlanTask {
  const goal = prose(section(task, "goal"));
  const description = prose(section(task, "description")) || goal;
  return {
    id: task.id,
    title: task.title,
    goal,
    description,
    scope: bulletValues(section(task, "scope")),
    outOfScope: bulletValues(section(task, "outOfScope")),
    dependencies: bulletValues(section(task, "dependencies")),
    validation: bulletValues(section(task, "validation")),
    completionCriteria: bulletValues(section(task, "completionCriteria")),
    notes: bulletValues(section(task, "notes")),
    priority: task.priority,
    type: task.type,
    ...(task.execution === undefined ? {} : { execution: task.execution }),
    source: { startLine: task.startLine, endLine: task.endLine },
  };
}

function validateTasks(tasks: PlanTask[], diagnostics: PlanDiagnostic[]): void {
  const seen = new Map<string, number>();
  for (const task of tasks) {
    const previous = seen.get(task.id);
    if (previous !== undefined) {
      diagnostics.push({
        level: "error",
        code: "duplicate_task_id",
        message: `Task id ${task.id} is duplicated; first occurrence is on line ${previous}.`,
        line: task.source.startLine,
        taskId: task.id,
      });
    } else {
      seen.set(task.id, task.source.startLine);
    }
    if (!task.goal) {
      diagnostics.push({ level: "warning", code: "missing_goal", message: "Task has no Goal section.", line: task.source.startLine, taskId: task.id });
    }
    if (task.validation.length === 0) {
      diagnostics.push({ level: "warning", code: "missing_validation", message: "Task has no validation steps.", line: task.source.startLine, taskId: task.id });
    }
    if (task.execution === undefined) {
      diagnostics.push({
        level: "error",
        code: "missing_execution_contract",
        message: "Task metadata must include a machine-readable execution contract before review can advance to approval.",
        line: task.source.startLine,
        taskId: task.id,
      });
    }
    if (task.completionCriteria.length === 0) {
      diagnostics.push({ level: "error", code: "missing_completion_criteria", message: "Task must define completion criteria.", line: task.source.startLine, taskId: task.id });
    }
    if (task.dependencies.includes(task.id)) {
      diagnostics.push({ level: "error", code: "self_dependency", message: "Task cannot depend on itself.", line: task.source.startLine, taskId: task.id });
    }
  }

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        diagnostics.push({
          level: "error",
          code: "unknown_dependency",
          message: `Task depends on unknown plan task ${dependency}.`,
          line: task.source.startLine,
          taskId: task.id,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const graph = new Map(tasks.map((task) => [task.id, task.dependencies]));
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      diagnostics.push({
        level: "error",
        code: "dependency_cycle",
        message: `Dependency cycle detected: ${[...path, id].join(" -> ")}.`,
        taskId: id,
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, []);
}

export function parsePlanText(text: string, path = "PLAN.md"): ParsedPlan {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const diagnostics: PlanDiagnostic[] = [];
  const tasks: PlanTask[] = [];
  let title = basename(path);
  let current: MutableTask | undefined;
  let currentSection: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (/^#\s+/.test(line) && !/^##\s+/.test(line) && title === basename(path)) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }

    const heading = parseTaskHeading(line);
    if (heading !== undefined) {
      if (current !== undefined) {
        current.endLine = lineNumber - 1;
        tasks.push(finalizeTask(current));
      }
      current = {
        id: heading.id,
        title: heading.title,
        priority: 2,
        type: "task",
        sections: new Map(),
        startLine: lineNumber,
        endLine: lines.length,
      };
      currentSection = undefined;
      continue;
    }

    if (current === undefined) continue;

    const metadata = parseTaskMetadata(line);
    if (metadata !== undefined) {
      if (metadata.__invalid === true) {
        diagnostics.push({
          level: "error",
          code: "invalid_task_metadata",
          message: "Task metadata must be a valid JSON object.",
          line: lineNumber,
          taskId: current.id,
        });
      } else {
        if (typeof metadata.id === "string" && metadata.id !== current.id) {
          diagnostics.push({
            level: "error",
            code: "task_id_mismatch",
            message: `Heading id ${current.id} does not match metadata id ${metadata.id}.`,
            line: lineNumber,
            taskId: current.id,
          });
        }
        current.priority = metadataPriority(metadata.priority);
        current.type = metadataTaskType(metadata.type);
        if (metadata.execution !== undefined) {
          const execution = metadataExecution(metadata.execution);
          if (execution === undefined) {
            diagnostics.push({
              level: "error",
              code: "invalid_execution_contract",
              message: "Task execution metadata must contain string arrays writePaths and validations plus explicit boolean allowDependencyChanges, allowFullSuite, and allowLocalChange fields.",
              line: lineNumber,
              taskId: current.id,
            });
          } else {
            current.execution = execution;
          }
        }
      }
      continue;
    }

    const sectionHeading = /^###\s+(.+?)\s*$/.exec(line);
    if (sectionHeading?.[1]) {
      const normalized = normalizeSection(sectionHeading[1]);
      currentSection = SECTION_ALIASES[normalized] ?? normalized;
      if (!current.sections.has(currentSection)) current.sections.set(currentSection, []);
      continue;
    }

    if (currentSection !== undefined) {
      current.sections.get(currentSection)?.push(line);
    }
  }

  if (current !== undefined) tasks.push(finalizeTask(current));
  if (tasks.length === 0) {
    diagnostics.push({ level: "error", code: "no_tasks", message: "Plan contains no task headings." });
  }
  validateTasks(tasks, diagnostics);

  return { path, title, hash: sha256(text), tasks, diagnostics };
}

export function parsePlanFile(path: string): ParsedPlan {
  return parsePlanText(readFileSync(path, "utf8"), path);
}
