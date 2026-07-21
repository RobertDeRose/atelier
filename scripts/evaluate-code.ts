#!/usr/bin/env -S node --experimental-strip-types
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type ExpectedResult = { path: string; relevance: number; rationale?: string };
type Task = {
  id: string;
  query: string;
  literals?: string[];
  expectedPaths?: string[];
  expectedResults?: ExpectedResult[];
  repos?: string[];
};
type Run = {
  method: "baseline" | "codesearch";
  status: number | null;
  durationMs: number;
  resultCount: number;
  paths: string[];
  bytes: number;
  stdout: string;
  stderr: string;
};

const root = resolve(process.argv[2] ?? process.cwd());
const tasksPath = resolve(process.argv[3] ?? "evaluation/tasks.json");
const out = resolve(process.argv[4] ?? ".atelier/evaluation");
mkdirSync(out, { recursive: true });
const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Task[];
const coldStart = tasks[0] === undefined ? undefined : runCodesearch(tasks[0]);
const report = tasks.map((task) => ({ task, baseline: runBaseline(task), codesearch: runCodesearch(task) }));
const summary = report.map(({ task, baseline, codesearch }) => ({
  id: task.id,
  query: task.query,
  expectedResults: expectedResults(task),
  baseline: score(baseline, task),
  codesearch: score(codesearch, task),
}));
const generatedAt = new Date().toISOString();
const payload = {
  generatedAt,
  root,
  tasksPath,
  coldStart: coldStart === undefined ? undefined : summarizeRun(coldStart),
  report,
  summary,
  aggregate: {
    baseline: aggregate(summary.map((item) => item.baseline)),
    codesearch: aggregate(summary.map((item) => item.codesearch)),
  },
};
const path = resolve(out, `comparison-${Date.now()}.json`);
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(resolve(out, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ generatedAt, path, coldStart: payload.coldStart, aggregate: payload.aggregate, summary }, null, 2)}\n`);

function runBaseline(task: Task): Run {
  const terms = task.literals?.length ? task.literals : task.query.split(/\s+/).filter((word) => word.length >= 4).slice(0, 4);
  const started = Date.now();
  const patterns = terms.length > 0 ? terms : [task.query];
  const args = [
    "--json", "--line-number", "--hidden", "--fixed-strings",
    "--glob", "!.git/**", "--glob", "!node_modules/**",
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
  return {
    method: "baseline",
    status: result.status,
    durationMs: Date.now() - started,
    resultCount: count,
    paths,
    bytes: Buffer.byteLength(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runCodesearch(task: Task): Run {
  const started = Date.now();
  const args = ["--experimental-strip-types", "apps/cli/src/main.ts", "--root", root, "code", "search", task.query, "--json", ...(task.repos?.length ? ["--repo", task.repos.join(",")] : [])];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  let rows: Array<{ path?: string }> = [];
  try {
    const value = JSON.parse(result.stdout) as unknown;
    rows = Array.isArray(value) ? value as Array<{ path?: string }> : [];
  } catch { /* retain raw output */ }
  const paths: string[] = [];
  for (const row of rows) if (typeof row.path === "string") pushUnique(paths, normalizePath(row.path));
  return {
    method: "codesearch",
    status: result.status,
    durationMs: Date.now() - started,
    resultCount: rows.length,
    paths,
    bytes: Buffer.byteLength(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
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
  if (scores.length === 0) return { tasks: 0, durationMs: 0, bytes: 0, meanWeightedRecall: 0, meanReciprocalRank: 0, meanNdcgAt10: 0 };
  return {
    tasks: scores.length,
    durationMs: scores.reduce((sum, item) => sum + item.durationMs, 0),
    bytes: scores.reduce((sum, item) => sum + item.bytes, 0),
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
    status: run.status,
    durationMs: run.durationMs,
    resultCount: run.resultCount,
    pathCount: run.paths.length,
    bytes: run.bytes,
    paths: run.paths,
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
