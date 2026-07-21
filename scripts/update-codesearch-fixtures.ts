#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const rawArgs = process.argv.slice(2);
const allowEmpty = rawArgs.includes("--allow-empty");
const positional = rawArgs.filter((argument) => argument !== "--allow-empty");
const probe = resolve(positional[0] ?? ".atelier/codesearch-probe");
const output = resolve(positional[1] ?? "tests/fixtures/codesearch-real");
if (!existsSync(probe)) throw new Error(`Probe directory does not exist: ${probe}`);

const sources = [
  ...["status_after", "mcp_contract", "search", "search_semantic", "search_literal", "symbols", "search_after_edit", "semantic", "hybrid", "literal", "fetch", "outline", "impact", "codesearch_doctor", "codesearch_stats", "direct_search", "store_metadata", "conformance"]
    .map((name) => ({ name, path: resolve(probe, `${name}.stdout`) })),
  { name: "evaluation", path: resolve(probe, "evaluation", "latest.json") },
];
const available = sources.filter((source) => existsSync(source.path));
const repositoryRoot = detectRepositoryRoot(probe) ?? process.cwd();
if (available.length === 0 && !allowEmpty) {
  throw new Error([
    `No codesearch probe fixtures were found beneath: ${probe}`,
    "Run `mise run collect:codesearch` first, or pass --allow-empty when intentionally testing an empty probe.",
    `Expected at least one of: ${sources.map((source) => source.path).join(", ")}`,
  ].join("\n"));
}

mkdirSync(output, { recursive: true });
const manifest: Record<string, unknown> = { generatedFrom: basename(probe), normalizedAt: "<normalized>", fixtures: {} };
for (const source of available) {
  const raw = readFileSync(source.path, "utf8").trim();
  let value: unknown = raw;
  try { value = JSON.parse(raw) as unknown; } catch { /* retain text fixture */ }
  const normalized = normalize(value);
  const target = resolve(output, `${source.name}.json`);
  writeFileSync(target, `${JSON.stringify(normalized, null, 2)}\n`);
  (manifest.fixtures as Record<string, unknown>)[source.name] = `${source.name}.json`;
}
writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ probe, output, fixtures: Object.keys(manifest.fixtures as object) }, null, 2)}\n`);

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value
    .replaceAll(repositoryRoot, "<REPOSITORY_ROOT>")
    .replace(/\/Users\/[^/]+/g, "/Users/<USER>")
    .replace(/\/home\/[^/]+/g, "/home/<USER>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (["retrievedAt", "observedAt", "generatedAt", "lastIndexedAt", "lastQueryAt"].includes(key)) output[key] = "<TIMESTAMP>";
      else if (["db_path", "project_path", "repositoryRoot", "root", "cwd"].includes(key) && typeof item === "string") output[key] = `<${key.toUpperCase()}>`;
      else output[key] = normalize(item);
    }
    return output;
  }
  return value;
}

function detectRepositoryRoot(probeDirectory: string): string | undefined {
  const evaluationPath = resolve(probeDirectory, "evaluation", "latest.json");
  if (existsSync(evaluationPath)) {
    try {
      const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8")) as { root?: unknown };
      if (typeof evaluation.root === "string" && evaluation.root) return evaluation.root;
    } catch { /* fall through to status fixture */ }
  }
  const statusPath = resolve(probeDirectory, "status_after.stdout");
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workspace?: { roots?: unknown[] } };
      const root = status.workspace?.roots?.[0];
      if (typeof root === "string" && root) return root;
    } catch { /* no repository root available */ }
  }
  return undefined;
}
