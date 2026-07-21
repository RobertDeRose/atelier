#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const probe = resolve(process.argv[2] ?? ".atelier/codesearch-probe");
const output = resolve(process.argv[3] ?? "tests/fixtures/codesearch-real");
if (!existsSync(probe)) throw new Error(`Probe directory does not exist: ${probe}`);
mkdirSync(output, { recursive: true });
const names = ["status_after", "mcp_contract", "search", "symbols", "search_after_edit", "fetch", "outline", "impact", "conformance"];
const manifest: Record<string, unknown> = { generatedFrom: basename(probe), normalizedAt: "<normalized>", fixtures: {} };
for (const name of names) {
  const source = resolve(probe, `${name}.stdout`);
  if (!existsSync(source)) continue;
  const raw = readFileSync(source, "utf8").trim();
  let value: unknown = raw;
  try { value = JSON.parse(raw) as unknown; } catch { /* text fixture */ }
  const normalized = normalize(value);
  const target = resolve(output, `${name}.json`);
  writeFileSync(target, `${JSON.stringify(normalized, null, 2)}\n`);
  (manifest.fixtures as Record<string, unknown>)[name] = `${name}.json`;
}
writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ probe, output, fixtures: Object.keys(manifest.fixtures as object) }, null, 2)}\n`);

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value
    .replaceAll(process.cwd(), "<REPOSITORY_ROOT>")
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
