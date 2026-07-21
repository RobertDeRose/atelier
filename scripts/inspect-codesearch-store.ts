#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const store = resolve(root, ".codesearch.db");
const entries: Array<{ path: string; type: string; size: number; mode: string; modifiedAt: string }> = [];

if (existsSync(store)) walk(store, 0);
process.stdout.write(`${JSON.stringify({ root, store, exists: existsSync(store), entries }, null, 2)}\n`);

function walk(path: string, depth: number): void {
  if (depth > 3) return;
  const stat = lstatSync(path);
  entries.push({
    path: relative(root, path).replaceAll("\\", "/") || ".",
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
    size: stat.size,
    mode: `0${(stat.mode & 0o777).toString(8)}`,
    modifiedAt: stat.mtime.toISOString(),
  });
  if (!stat.isDirectory()) return;
  for (const child of readdirSync(path).sort()) walk(resolve(path, child), depth + 1);
}
