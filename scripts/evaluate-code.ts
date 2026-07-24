#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { rankCodePathsByFocus, resolveCodeSearchFocus, type CodeSearchFocus } from "../packages/core/src/index.ts";

type ExpectedResult = { path: string; relevance: number; rationale?: string };
type Task = {
  id: string;
  query: string;
  literals?: string[];
  expectedPaths?: string[];
  expectedResults?: ExpectedResult[];
  repos?: string[];
  focus?: CodeSearchFocus;
};
type ProviderName = "codesearch" | "octocode";
type Run = {
  method: "baseline" | ProviderName;
  status: number | null;
  durationMs: number;
  resultCount: number;
  paths: string[];
  providerPaths: string[];
  focus: string;
  reranked: boolean;
  bytes: number;
  stdout: string;
  stderr: string;
  degradedResultCount: number;
  fusionResultCount: number;
  literalHintCount: number;
  warnings: string[];
};

const parsed = parseArguments(process.argv.slice(2));
const root = resolve(parsed.positionals[0] ?? process.cwd());
const tasksPath = resolve(parsed.positionals[1] ?? "evaluation/tasks.json");
const out = resolve(parsed.positionals[2] ?? ".atelier/evaluation");
const providers = parseProviders(parsed.options.providers ?? process.env.ATELIER_EVALUATION_PROVIDERS ?? "codesearch");
mkdirSync(out, { recursive: true });
const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Task[];
const coldStartRuns = Object.fromEntries(providers.map((provider) => [provider, tasks[0] === undefined ? undefined : runProvider(tasks[0], provider)])) as Partial<Record<ProviderName, Run | undefined>>;
const report = tasks.map((task) => {
  const providerRuns = Object.fromEntries(providers.map((provider) => [provider, runProvider(task, provider)])) as Record<ProviderName, Run>;
  return {
    task: { ...task, resolvedFocus: resolveCodeSearchFocus(task.focus, task.query) },
    baseline: runBaseline(task),
    providers: providerRuns,
    ...providerRuns,
  };
});
const summary = report.map(({ task, baseline, providers: providerRuns }) => {
  const providerScores = Object.fromEntries(providers.map((provider) => [provider, score(providerRuns[provider], task)])) as Record<ProviderName, ReturnType<typeof score>>;
  return {
    id: task.id,
    query: task.query,
    expectedResults: expectedResults(task),
    baseline: score(baseline, task),
    providers: providerScores,
    ...providerScores,
  };
});
const generatedAt = new Date().toISOString();
const providerAggregates = Object.fromEntries(providers.map((provider) => [provider, aggregate(summary.map((item) => item.providers[provider]))])) as Record<ProviderName, ReturnType<typeof aggregate>>;
const coldStarts = Object.fromEntries(providers.flatMap((provider) => {
  const run = coldStartRuns[provider];
  return run === undefined ? [] : [[provider, summarizeRun(run)]];
})) as Partial<Record<ProviderName, ReturnType<typeof summarizeRun>>>;
const firstColdStart = coldStarts[providers[0]];
const payload = {
  generatedAt,
  root,
  tasksPath,
  providers,
  ...(firstColdStart === undefined ? {} : { coldStart: firstColdStart }),
  coldStarts,
  report,
  summary,
  aggregate: {
    baseline: aggregate(summary.map((item) => item.baseline)),
    providers: providerAggregates,
    ...providerAggregates,
  },
};
const path = resolve(out, `comparison-${Date.now()}.json`);
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(resolve(out, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ generatedAt, path, providers, coldStarts, aggregate: payload.aggregate, summary }, null, 2)}\n`);

function parseArguments(args: string[]): { positionals: string[]; options: { providers?: string } } {
  const positionals: string[] = [];
  const options: { providers?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--providers" || value === "--provider") {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a comma-separated provider list`);
      options.providers = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--providers=")) {
      options.providers = value.slice("--providers=".length);
      continue;
    }
    if (value.startsWith("--provider=")) {
      options.providers = value.slice("--provider=".length);
      continue;
    }
    positionals.push(value);
  }
  return { positionals, options };
}

function parseProviders(value: string): ProviderName[] {
  const providers = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (providers.length === 0) throw new Error("At least one evaluation provider is required");
  for (const provider of providers) {
    if (provider !== "codesearch" && provider !== "octocode") throw new Error(`Unsupported evaluation provider: ${provider}`);
  }
  return providers as ProviderName[];
}

function runBaseline(task: Task): Run {
  const terms = task.literals?.length ? task.literals : task.query.split(/\s+/).filter((word) => word.length >= 4).slice(0, 4);
  const started = Date.now();
  const patterns = terms.length > 0 ? terms : [task.query];
  const codesearchIgnore = resolve(root, ".codesearchignore");
  const args = [
    "--json", "--line-number", "--hidden", "--fixed-strings",
    "--glob", "!.git/**", "--glob", "!node_modules/**",
    ...(existsSync(codesearchIgnore) ? ["--ignore-file", codesearchIgnore] : []),
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    ".",
  ];
  const result = spawnSync("rg", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const paths: string[] = [];
  let count = 0;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string } } };
      const path = event.data?.path?.text;
      if (event.type === "match" && path) {
        pushUnique(paths, normalizePath(path));
        count += 1;
      }
    } catch { /* retain raw output */ }
  }
  const focused = rankCodePathsByFocus(paths, task.focus, task.query);
  return {
    method: "baseline",
    status: result.status,
    durationMs: Date.now() - started,
    resultCount: count,
    paths: focused.paths,
    providerPaths: paths,
    focus: focused.focus,
    reranked: focused.reranked,
    bytes: Buffer.byteLength(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
    degradedResultCount: 0,
    fusionResultCount: 0,
    literalHintCount: task.literals?.length ?? 0,
    warnings: [],
  };
}

function runProvider(task: Task, provider: ProviderName): Run {
  const started = Date.now();
  const args = [
    "--experimental-strip-types", "apps/cli/src/main.ts", "--root", root, "code", "search", task.query,
    "--provider", provider, "--mode", "auto", "--focus", task.focus ?? "auto", "--json",
    ...(task.literals?.length ? ["--hint", task.literals.join(",")] : []),
    ...(task.repos?.length ? ["--repo", task.repos.join(",")] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  let rows: Array<{
    path?: string;
    providerRank?: number;
    retrievalMethods?: string[];
    provenance?: { degraded?: boolean; warnings?: string[]; reranked?: boolean; requestedFilters?: Record<string, unknown>; postProcessing?: string[] };
  }> = [];
  try {
    const value = JSON.parse(result.stdout) as unknown;
    rows = Array.isArray(value) ? value as typeof rows : [];
  } catch { /* retain raw output */ }
  const paths: string[] = [];
  for (const row of rows) if (typeof row.path === "string") pushUnique(paths, normalizePath(row.path));
  const providerPaths: string[] = [];
  for (const row of [...rows].sort((left, right) => (left.providerRank ?? Number.MAX_SAFE_INTEGER) - (right.providerRank ?? Number.MAX_SAFE_INTEGER))) {
    if (typeof row.path === "string") pushUnique(providerPaths, normalizePath(row.path));
  }
  const resolvedFocus = rows.map((row) => row.provenance?.requestedFilters?.resolvedFocus).find((value): value is string => typeof value === "string") ?? resolveCodeSearchFocus(task.focus, task.query);
  return {
    method: provider,
    status: result.status,
    durationMs: Date.now() - started,
    resultCount: rows.length,
    paths,
    providerPaths,
    focus: resolvedFocus,
    reranked: rows.some((row) => row.provenance?.reranked === true),
    bytes: Buffer.byteLength(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
    degradedResultCount: rows.filter((row) => row.provenance?.degraded === true).length,
    fusionResultCount: rows.filter((row) => row.retrievalMethods?.includes("semantic") && row.retrievalMethods.includes("lexical")).length,
    literalHintCount: Math.max(0, ...rows.map((row) => {
      const hints = row.provenance?.requestedFilters?.literalHints;
      return Array.isArray(hints) ? hints.length : 0;
    })),
    warnings: [...new Set(rows.flatMap((row) => row.provenance?.warnings ?? []))],
  };
}

function score(run: Run, task: Task) {
  const expected = expectedResults(task);
  const ranked = expected.map((item) => {
    const index = run.paths.findIndex((path) => pathsMatch(path, item.path));
    return { ...item, rank: index < 0 ? undefined : index + 1 };
  });
  const found = ranked.filter((item) => item.rank !== undefined);
  const totalRelevance = expected.reduce((sum, item) => sum + item.relevance, 0);
  const foundRelevance = found.reduce((sum, item) => sum + item.relevance, 0);
  const dcg = ranked.reduce((sum, item) => item.rank === undefined || item.rank > 10
    ? sum
    : sum + gain(item.relevance) / Math.log2(item.rank + 1), 0);
  const ideal = [...expected]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10)
    .reduce((sum, item, index) => sum + gain(item.relevance) / Math.log2(index + 2), 0);
  const firstRelevantRank = found.map((item) => item.rank!).sort((a, b) => a - b)[0];
  return {
    ...summarizeRun(run),
    paths: run.paths,
    expectedFound: found.map((item) => item.path),
    expectedMissed: ranked.filter((item) => item.rank === undefined).map((item) => item.path),
    rankedExpected: ranked,
    weightedRecall: totalRelevance === 0 ? 1 : round(foundRelevance / totalRelevance),
    reciprocalRank: firstRelevantRank === undefined ? 0 : round(1 / firstRelevantRank),
    ndcgAt10: ideal === 0 ? 1 : round(dcg / ideal),
  };
}

function aggregate(scores: Array<ReturnType<typeof score>>) {
  if (scores.length === 0) return { tasks: 0, durationMs: 0, bytes: 0, degradedResultCount: 0, fusionResultCount: 0, literalHintCount: 0, rerankedTasks: 0, warnings: [], meanWeightedRecall: 0, meanReciprocalRank: 0, meanNdcgAt10: 0 };
  return {
    tasks: scores.length,
    durationMs: scores.reduce((sum, item) => sum + item.durationMs, 0),
    bytes: scores.reduce((sum, item) => sum + item.bytes, 0),
    degradedResultCount: scores.reduce((sum, item) => sum + item.degradedResultCount, 0),
    fusionResultCount: scores.reduce((sum, item) => sum + item.fusionResultCount, 0),
    literalHintCount: scores.reduce((sum, item) => sum + item.literalHintCount, 0),
    rerankedTasks: scores.filter((item) => item.reranked).length,
    warnings: [...new Set(scores.flatMap((item) => item.warnings))],
    meanWeightedRecall: round(scores.reduce((sum, item) => sum + item.weightedRecall, 0) / scores.length),
    meanReciprocalRank: round(scores.reduce((sum, item) => sum + item.reciprocalRank, 0) / scores.length),
    meanNdcgAt10: round(scores.reduce((sum, item) => sum + item.ndcgAt10, 0) / scores.length),
  };
}

function expectedResults(task: Task): ExpectedResult[] {
  if (task.expectedResults?.length) return task.expectedResults;
  return (task.expectedPaths ?? []).map((path) => ({ path, relevance: 3 }));
}

function summarizeRun(run: Run) {
  return {
    method: run.method,
    status: run.status,
    durationMs: run.durationMs,
    resultCount: run.resultCount,
    pathCount: run.paths.length,
    bytes: run.bytes,
    paths: run.paths,
    providerPaths: run.providerPaths,
    focus: run.focus,
    reranked: run.reranked,
    degradedResultCount: run.degradedResultCount,
    fusionResultCount: run.fusionResultCount,
    literalHintCount: run.literalHintCount,
    warnings: run.warnings,
  };
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isAbsolute(path)) return normalized;
  const candidate = relative(root, path).replaceAll("\\", "/");
  return candidate === "" || candidate.startsWith("../") ? normalized : candidate;
}

function pathsMatch(actual: string, expected: string): boolean {
  const normalizedActual = actual.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedExpected = expected.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalizedActual === normalizedExpected || normalizedActual.endsWith(`/${normalizedExpected}`);
}

function pushUnique(paths: string[], path: string): void {
  if (!paths.includes(path)) paths.push(path);
}

function gain(relevance: number): number {
  return (2 ** relevance) - 1;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
