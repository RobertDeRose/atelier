import { readFileSync, writeFileSync } from "node:fs";
import type { TaskExecutionContract } from "../domain/types.ts";
import { parsePlanText } from "./plan-parser.ts";

export interface PlanScopeUpdate {
  taskId: string;
  execution: TaskExecutionContract;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function normalizeExecutionContract(contract: TaskExecutionContract): TaskExecutionContract {
  return {
    writePaths: unique(contract.writePaths),
    allowDependencyChanges: contract.allowDependencyChanges,
    validations: unique(contract.validations),
    allowFullSuite: contract.allowFullSuite,
    allowLocalChange: contract.allowLocalChange,
  };
}

function authorizationLines(contract: TaskExecutionContract): string[] {
  return [
    "### Authorization",
    "",
    `- Writable paths: ${contract.writePaths.map((path) => `\`${path}\``).join(", ")}`,
    `- Dependency changes: ${contract.allowDependencyChanges ? "allowed" : "not allowed"}`,
    `- Focused validations: ${contract.validations.length === 0 ? "none" : contract.validations.map((name) => `\`${name}\``).join(", ")}`,
    `- Full validation suite: ${contract.allowFullSuite ? "allowed" : "not allowed"}`,
    `- Local commit/change: ${contract.allowLocalChange ? "allowed" : "not allowed"}`,
    "",
  ];
}

function updateAuthorizationSection(taskLines: string[], contract: TaskExecutionContract): string[] {
  const start = taskLines.findIndex((line) => /^###\s+Authorization\s*$/i.test(line));
  if (start !== -1) {
    let end = start + 1;
    while (end < taskLines.length && !/^###\s+/.test(taskLines[end] ?? "")) end += 1;
    return [...taskLines.slice(0, start), ...authorizationLines(contract), ...taskLines.slice(end)];
  }
  const notes = taskLines.findIndex((line) => /^###\s+Notes\s*$/i.test(line));
  const insertion = notes === -1 ? taskLines.length : notes;
  return [...taskLines.slice(0, insertion), ...authorizationLines(contract), ...taskLines.slice(insertion)];
}

export function updatePlanTaskScopeText(text: string, update: PlanScopeUpdate, path = "PLAN.md"): string {
  const parsed = parsePlanText(text, path);
  const task = parsed.tasks.find((candidate) => candidate.id === update.taskId);
  if (task === undefined) throw new Error(`Unknown plan task: ${update.taskId}`);
  const contract = normalizeExecutionContract(update.execution);
  if (contract.writePaths.length === 0) throw new Error("At least one writable path is required.");

  const lines = text.split("\n");
  const start = task.source.startLine - 1;
  const nextTask = parsed.tasks.find((candidate) => candidate.source.startLine > task.source.startLine);
  const end = nextTask === undefined ? lines.length : nextTask.source.startLine - 1;
  const taskLines = lines.slice(start, end);
  const metadataIndex = taskLines.findIndex((line) => /^\s*<!--\s*atlr:task\s+/.test(line));
  if (metadataIndex === -1) throw new Error(`Task ${task.id} has no atlr:task metadata comment.`);
  const metadataMatch = /^\s*<!--\s*atlr:task\s+(.+?)\s*-->\s*$/.exec(taskLines[metadataIndex] ?? "");
  if (metadataMatch?.[1] === undefined) throw new Error(`Task ${task.id} metadata is malformed.`);
  const metadata = JSON.parse(metadataMatch[1]) as Record<string, unknown>;
  metadata.execution = contract;
  taskLines[metadataIndex] = `<!-- atlr:task ${JSON.stringify(metadata)} -->`;
  const updatedTask = updateAuthorizationSection(taskLines, contract);
  const output = [...lines.slice(0, start), ...updatedTask, ...lines.slice(end)].join("\n");
  return text.endsWith("\n") && !output.endsWith("\n") ? `${output}\n` : output;
}

export function updatePlanTaskScopeFile(path: string, update: PlanScopeUpdate): TaskExecutionContract {
  const current = readFileSync(path, "utf8");
  const normalized = normalizeExecutionContract(update.execution);
  writeFileSync(path, updatePlanTaskScopeText(current, { ...update, execution: normalized }, path), "utf8");
  return normalized;
}
