import type { ParsedPlan, PlanTask, TaskRecord, WorkflowMode } from "../domain/types.ts";
import { inferCodeSearchFocus, type ResolvedCodeSearchFocus } from "../code/focus.ts";

export type RepositoryStateQueryPurpose = "plan_objective" | "reviewed_plan" | "active_task" | "task_scope";

export interface RepositoryStateQuery {
  purpose: RepositoryStateQueryPurpose;
  text: string;
  focus: ResolvedCodeSearchFocus;
  literalHints: string[];
  limit: number;
}

export interface RepositoryStatePlan {
  queries: RepositoryStateQuery[];
  explanation: string[];
}

export interface RepositoryStatePlanRequest {
  mode: WorkflowMode;
  planObjective?: string;
  activeTask?: TaskRecord;
  planTask?: PlanTask;
  plan?: ParsedPlan;
  maximumQueries?: number;
}

const GENERIC_HINTS = new Set([
  "Agentic", "Atelier", "Working", "State", "Plan", "Task", "Code", "Provider", "Repository",
  "Implementation", "Review", "Validation", "Current", "Manual", "Edited",
]);

export class RepositoryStatePlanner {
  plan(request: RepositoryStatePlanRequest): RepositoryStatePlan {
    const candidates: RepositoryStateQuery[] = [];
    const explanation: string[] = [];

    const objective = normalizeText(request.planObjective);
    if (request.mode === "plan" && objective !== undefined) {
      candidates.push(this.query("plan_objective", objective, 6));
      explanation.push("Planned repository retrieval from the durable planning objective.");
    }

    if (request.mode === "plan" && request.plan !== undefined && request.plan.tasks.length > 0) {
      const reviewedPlanText = normalizeText([
        request.plan.title,
        ...request.plan.tasks.slice(0, 4).flatMap((task) => [task.title, task.goal, ...task.scope.slice(0, 2)]),
      ].join(" "));
      if (reviewedPlanText !== undefined && reviewedPlanText !== objective) {
        candidates.push(this.query("reviewed_plan", reviewedPlanText, 4));
        explanation.push("Planned repository retrieval from the reviewed plan revision.");
      }
    }

    if (request.activeTask !== undefined) {
      const activeTaskText = normalizeText([
        request.activeTask.title,
        request.activeTask.description,
        request.activeTask.design,
        request.activeTask.notes,
      ].filter((value): value is string => Boolean(value)).join(" "));
      if (activeTaskText !== undefined) {
        candidates.push(this.query("active_task", activeTaskText, 6));
        explanation.push(`Planned repository retrieval from active task ${request.activeTask.id}.`);
      }
    }

    if (request.planTask !== undefined) {
      const scopeText = normalizeText([
        request.planTask.title,
        request.planTask.goal,
        request.planTask.description,
        ...request.planTask.scope,
        ...request.planTask.validation,
        ...request.planTask.completionCriteria,
      ].join(" "));
      if (scopeText !== undefined && !candidates.some((query) => query.text === scopeText)) {
        candidates.push(this.query("task_scope", scopeText, 4));
        explanation.push(`Planned repository retrieval from reviewed-plan scope ${request.planTask.id}.`);
      }
    }

    const queries = deduplicateQueries(candidates).slice(0, request.maximumQueries ?? 2);
    if (queries.length === 0) explanation.push("No durable planning objective or active task supplied a repository retrieval query.");
    return { queries, explanation };
  }

  private query(purpose: RepositoryStateQueryPurpose, text: string, limit: number): RepositoryStateQuery {
    return {
      purpose,
      text,
      focus: inferCodeSearchFocus(text),
      literalHints: extractLiteralHints(text),
      limit,
    };
  }
}

export function extractLiteralHints(text: string, maximum = 8): string[] {
  const hints: string[] = [];
  const add = (value: string): void => {
    const normalized = value.replace(/^['"`]|['"`]$/g, "").trim();
    if (normalized.length < 3 || GENERIC_HINTS.has(normalized) || hints.includes(normalized)) return;
    hints.push(normalized);
  };

  for (const match of text.matchAll(/`([^`]+)`/g)) add(match[1] ?? "");
  for (const token of text.match(/[A-Za-z0-9_./:@-]+/g) ?? []) {
    const codeShaped = token.includes("/")
      || token.includes(".")
      || token.includes("_")
      || /[a-z][A-Z]/.test(token)
      || /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)
      || /^[A-Z][A-Z0-9_]{2,}$/.test(token);
    if (codeShaped) add(token.replace(/[.,;:!?]+$/g, ""));
    if (hints.length >= maximum) break;
  }
  return hints.slice(0, maximum);
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 1200 ? normalized.slice(0, 1200) : normalized;
}

function deduplicateQueries(queries: RepositoryStateQuery[]): RepositoryStateQuery[] {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = query.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
