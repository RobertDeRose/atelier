#!/usr/bin/env -S node --experimental-strip-types
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Task = { id: string; query: string; literals?: string[]; expectedPaths?: string[]; repos?: string[] };
type Run = { method: "baseline" | "codesearch"; status: number | null; durationMs: number; resultCount: number; paths: string[]; bytes: number; stdout: string; stderr: string };

const root = resolve(process.argv[2] ?? process.cwd());
const tasksPath = resolve(process.argv[3] ?? "evaluation/tasks.json");
const out = resolve(process.argv[4] ?? ".atelier/evaluation");
mkdirSync(out, { recursive: true });
const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Task[];
const report = tasks.map((task) => ({ task, baseline: runBaseline(task), codesearch: runCodesearch(task) }));
const summary = report.map(({ task, baseline, codesearch }) => ({
  id: task.id,
  expectedPaths: task.expectedPaths ?? [],
  baseline: score(baseline, task.expectedPaths),
  codesearch: score(codesearch, task.expectedPaths),
}));
const generatedAt = new Date().toISOString();
const payload = { generatedAt, root, tasksPath, report, summary };
const path = resolve(out, `comparison-${Date.now()}.json`);
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(resolve(out, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ generatedAt, path, summary }, null, 2)}\n`);

function runBaseline(task: Task): Run {
  const terms = task.literals?.length ? task.literals : task.query.split(/\s+/).filter((word) => word.length >= 4).slice(0, 4);
  const started = Date.now();
  const args = ["--json", "--line-number", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**", terms.join("|") || task.query, "."];
  const result = spawnSync("rg", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const paths = new Set<string>();
  let count = 0;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string } } };
      const path = event.data?.path?.text;
      if (event.type === "match" && path) { paths.add(path.replace(/^\.\//, "")); count += 1; }
    } catch { /* retain raw output */ }
  }
  return { method: "baseline", status: result.status, durationMs: Date.now() - started, resultCount: count, paths: [...paths], bytes: Buffer.byteLength(result.stdout), stdout: result.stdout, stderr: result.stderr };
}

function runCodesearch(task: Task): Run {
  const started = Date.now();
  const args = ["--experimental-strip-types", "apps/cli/src/main.ts", "--root", root, "code", "search", task.query, "--json", ...(task.repos?.length ? ["--repo", task.repos.join(",")] : [])];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  let rows: Array<{ path?: string }> = [];
  try { const value = JSON.parse(result.stdout) as unknown; rows = Array.isArray(value) ? value as Array<{ path?: string }> : []; } catch { /* retained */ }
  const paths = [...new Set(rows.map((row) => row.path).filter((path): path is string => typeof path === "string"))];
  return { method: "codesearch", status: result.status, durationMs: Date.now() - started, resultCount: rows.length, paths, bytes: Buffer.byteLength(result.stdout), stdout: result.stdout, stderr: result.stderr };
}

function score(run: Run, expected: string[] | undefined) {
  const expectedPaths = expected ?? [];
  const found = expectedPaths.filter((candidate) => run.paths.some((path) => path === candidate || path.endsWith(candidate)));
  return { status: run.status, durationMs: run.durationMs, resultCount: run.resultCount, pathCount: run.paths.length, bytes: run.bytes, expectedFound: found, expectedMissed: expectedPaths.filter((path) => !found.includes(path)) };
}
