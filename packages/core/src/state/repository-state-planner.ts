import type { ParsedPlan, PlanTask, TaskRecord, WorkflowMode } from "../domain/types.ts";
import { inferCodeSearchFocus, type ResolvedCodeSearchFocus } from "../code/focus.ts";

export type RepositoryStateQueryPurpose = "plan_objective" | "reviewed_plan" | "active_task" | "task_scope";
export type RepositoryStateQueryOperation = "search" | "symbols";
export type RepositoryStateQueryPhase = "semantic_discovery" | "exact_symbol_resolution";

export interface RepositoryStateQuery {
  operation: RepositoryStateQueryOperation;
  phase: RepositoryStateQueryPhase;
  purpose: RepositoryStateQueryPurpose;
  purposes: RepositoryStateQueryPurpose[];
  text: string;
  focus: ResolvedCodeSearchFocus;
  literalHints: string[];
  limit: number;
  evidenceRequirements: string[];
  reason: string;
}

export interface RepositoryStateDecision {
  kind: "direct_read";
  path: string;
  reason: string;
}

export interface RepositoryStatePlan {
  queries: RepositoryStateQuery[];
  decisions: RepositoryStateDecision[];
  explanation: string[];
}

export interface RepositoryStateEvidence {
  semanticDiscoveryComplete: boolean;
  resolvedIdentifiers: string[];
  unresolvedIdentifiers?: string[];
  knownPaths: string[];
}

export interface RepositoryStatePlanRequest {
  mode: WorkflowMode;
  planObjective?: string;
  activeTask?: TaskRecord;
  planTask?: PlanTask;
  plan?: ParsedPlan;
  evidence?: RepositoryStateEvidence;
  maximumQueries?: number;
}

interface QuerySource {
  purpose: RepositoryStateQueryPurpose;
  text: string;
  limit: number;
}

const GENERIC_HINTS = new Set([
  "Agentic", "Atelier", "Working", "State", "Plan", "Task", "Code", "Provider", "Repository",
  "Implementation", "Review", "Validation", "Current", "Manual", "Edited",
]);

export class RepositoryStatePlanner {
  plan(request: RepositoryStatePlanRequest): RepositoryStatePlan {
    const sources = this.sources(request);
    const explanation: string[] = [];
    const knownPaths = unique(sources.flatMap((source) => extractKnownPaths(source.text)));
    const evidenceKnownPaths = new Set((request.evidence?.knownPaths ?? []).map(normalizePath));
    const decisions = knownPaths
      .filter((path) => evidenceKnownPaths.has(path) || sources.some((source) => source.text.includes(path)))
      .map((path): RepositoryStateDecision => ({
        kind: "direct_read",
        path,
        reason: "Path is already known; read it directly instead of issuing another provider query.",
      }));
    if (decisions.length > 0) {
      explanation.push(`Suppressed provider retrieval for ${decisions.length} known path(s); read them directly.`);
    }

    const searchableSources = sources
      .filter((source) => {
        if (source.purpose !== "plan_objective") return true;
        if (!objectiveIsFullyScopedByKnownPaths(source.text, knownPaths)) return true;
        explanation.push("The planning objective names its implementation files explicitly; semantic discovery is unnecessary.");
        return false;
      })
      .map((source) => ({ ...source, text: removeKnownPaths(source.text, knownPaths) }))
      .filter((source) => hasSearchableText(source.text));
    const purposes = unique(searchableSources.map((source) => source.purpose));
    const semanticText = mergeSourceText(searchableSources);
    const maximumQueries = Math.max(0, request.maximumQueries ?? 2);
    const queries: RepositoryStateQuery[] = [];

    if (request.evidence?.semanticDiscoveryComplete !== true && semanticText !== undefined && maximumQueries > 0) {
      const primary = searchableSources[0]!;
      queries.push({
        operation: "search",
        phase: "semantic_discovery",
        purpose: primary.purpose,
        purposes,
        text: semanticText,
        focus: inferCodeSearchFocus(semanticText),
        literalHints: extractLiteralHints(semanticText),
        limit: Math.max(...searchableSources.map((source) => source.limit)),
        evidenceRequirements: ["Locate relevant implementation, tests, and documentation before exact identifier resolution."],
        reason: "Run one broad semantic discovery query before considering exact symbol lookups.",
      });
      explanation.push(
        purposes.length > 1
          ? `Planned one broad semantic query and merged ${purposes.length} equivalent retrieval purposes.`
          : `Planned one broad semantic query from ${primary.purpose}.`,
      );
    } else if (request.evidence?.semanticDiscoveryComplete === true && semanticText !== undefined) {
      const resolved = new Set(request.evidence.resolvedIdentifiers);
      const explicitlyUnresolved = new Set(request.evidence.unresolvedIdentifiers ?? []);
      const identifiers = extractLiteralHints(semanticText)
        .filter((hint) => !isPathHint(hint) && isExactSymbolHint(hint) && !resolved.has(hint))
        .filter((hint) => request.evidence?.unresolvedIdentifiers === undefined || explicitlyUnresolved.has(hint));
      for (const identifier of identifiers.slice(0, maximumQueries)) {
        const primary = searchableSources.find((source) => extractLiteralHints(source.text).includes(identifier))
          ?? searchableSources[0]!;
        queries.push({
          operation: "symbols",
          phase: "exact_symbol_resolution",
          purpose: primary.purpose,
          purposes: unique(searchableSources
            .filter((source) => extractLiteralHints(source.text).includes(identifier))
            .map((source) => source.purpose)),
          text: identifier,
          focus: "source",
          literalHints: [identifier],
          limit: 10,
          evidenceRequirements: [`Resolve exact identifier ${identifier}.`],
          reason: `Exact identifier ${identifier} remained unresolved after semantic discovery.`,
        });
      }
      if (queries.length === 0) {
        explanation.push("Existing evidence resolves every exact identifier; no symbol lookup was planned.");
      } else {
        explanation.push(`Planned ${queries.length} exact symbol lookup(s) only for unresolved identifiers.`);
      }
    }

    if (queries.length === 0 && decisions.length === 0) {
      explanation.push("No durable planning objective or active task supplied a repository retrieval query.");
    }
    return { queries, decisions, explanation };
  }

  private sources(request: RepositoryStatePlanRequest): QuerySource[] {
    const sources: QuerySource[] = [];
    const objective = normalizeText(request.planObjective);
    if (request.mode === "plan" && objective !== undefined) {
      sources.push({ purpose: "plan_objective", text: objective, limit: 6 });
    }

    if (request.mode === "plan" && request.plan !== undefined && request.plan.tasks.length > 0) {
      const text = normalizeText([
        request.plan.title,
        ...request.plan.tasks.slice(0, 4).flatMap((task) => [task.title, task.goal, ...task.scope.slice(0, 2)]),
      ].join(" "));
      if (text !== undefined) sources.push({ purpose: "reviewed_plan", text, limit: 4 });
    }

    if (request.activeTask !== undefined) {
      const text = normalizeText([
        request.activeTask.title,
        request.activeTask.description,
        request.activeTask.design,
        request.activeTask.notes,
      ].filter((value): value is string => Boolean(value)).join(" "));
      if (text !== undefined) sources.push({ purpose: "active_task", text, limit: 6 });
    }

    if (request.planTask !== undefined) {
      const text = normalizeText([
        request.planTask.title,
        request.planTask.goal,
        request.planTask.description,
        ...request.planTask.scope,
        ...request.planTask.validation,
        ...request.planTask.completionCriteria,
      ].join(" "));
      if (text !== undefined) sources.push({ purpose: "task_scope", text, limit: 4 });
    }
    return deduplicateSources(sources);
  }
}

export function extractLiteralHints(text: string, maximum = 8): string[] {
  const hints: string[] = [];
  const add = (value: string): void => {
    const normalized = value.replace(/^['"`]|['"`]$/g, "").trim();
    if (normalized.length < 3 || GENERIC_HINTS.has(normalized) || hints.includes(normalized)) return;
    hints.push(normalized);
  };

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim() ?? "";
    if (isDirectReadPath(value) || value.includes("/")) add(value);
    else for (const token of value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) add(token);
  }
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


const DISCOVERY_LANGUAGE = /\b(?:find|locate|discover|identify|determine|investigate|where|architecture|impact|related|across|unknown|implementation location|which files?)\b/i;

/**
 * A plan objective that names every file it asks Atelier to change is already
 * a bounded direct-read request. Semantic search in that case adds latency and
 * can introduce irrelevant evidence; retain it only when the objective also
 * asks Atelier to discover an implementation location or broader impact.
 */
function objectiveIsFullyScopedByKnownPaths(text: string, knownPaths: readonly string[]): boolean {
  if (knownPaths.length === 0 || DISCOVERY_LANGUAGE.test(text)) return false;
  const normalized = text.toLowerCase();
  const mutationIntent = /\b(?:add|change|update|modify|export|remove|rename|create|write|verify|test|fix)\b/.test(normalized);
  return mutationIntent && knownPaths.every((path) => normalized.includes(path.toLowerCase()));
}

function extractKnownPaths(text: string): string[] {
  return extractLiteralHints(text).filter(isDirectReadPath).map(normalizePath);
}

function isDirectReadPath(value: string): boolean {
  const name = normalizePath(value).split("/").at(-1) ?? value;
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

function isExactSymbolHint(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    && (value.includes("_") || value.includes("$") || /[a-z0-9][A-Z]/.test(value));
}

function isPathHint(value: string): boolean {
  return value.includes("/") || isDirectReadPath(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function removeKnownPaths(text: string, paths: string[]): string {
  let result = text;
  for (const path of paths) {
    result = result.replaceAll(`\`${path}\``, " ").replaceAll(path, " ");
  }
  return normalizeText(result) ?? "";
}

function hasSearchableText(text: string): boolean {
  if (!text) return false;
  return !/^(?:inspect|read|open|review|check|the|file|path|and|in|at|from|only|directly|\s)+$/i.test(text);
}

function mergeSourceText(sources: QuerySource[]): string | undefined {
  const distinct = unique(sources.map((source) => source.text));
  return normalizeText(distinct.join(" "));
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 1200 ? normalized.slice(0, 1200) : normalized;
}

function deduplicateSources(sources: QuerySource[]): QuerySource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.purpose}:${source.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
