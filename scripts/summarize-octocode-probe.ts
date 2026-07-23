import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: summarize-octocode-probe.ts DIRECTORY");
type Check = { name: string; status: "passed" | "warning" | "failed"; detail: string };
const checks: Check[] = [];
function status(name: string): number {
  const path = join(directory, `${name}.status`);
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : 127;
}
function stderr(name: string): string {
  const path = join(directory, `${name}.stderr`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}
function addProcess(name: string, required = true): void {
  const code = status(name);
  checks.push({ name, status: code === 0 ? "passed" : required ? "failed" : "warning", detail: code === 0 ? "exit 0" : stderr(name) || `exit ${code}` });
}
for (const name of ["setup_config", "version", "help", "mcp_help", "config_show", "stats_before", "embedding_environment", "index", "stats_after", "adapter_index", "providers", "status", "search", "symbols", "mcp_contract"]) addProcess(name);
for (const name of ["models_help", "models_list", "related"]) addProcess(name, false);

let contract: {
  tools?: Array<{ name?: string }>;
  calls?: Record<string, { isError?: boolean; skipped?: boolean; reason?: string; error?: string; content?: Array<{ text?: string }> }>;
} = {};
try {
  contract = JSON.parse(readFileSync(join(directory, "mcp_contract.stdout"), "utf8")) as typeof contract;
} catch (error) {
  checks.push({ name: "contract:json", status: "failed", detail: error instanceof Error ? error.message : String(error) });
}
const toolNames = (contract.tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string");
for (const name of ["semantic_search", "view_signatures", "structural_search"]) {
  const advertised = toolNames.includes(name);
  checks.push({ name: `tool:${name}`, status: advertised ? "passed" : "warning", detail: advertised ? "advertised" : "not advertised" });
  if (!advertised) continue;
  const call = contract.calls?.[name];
  const text = call?.content?.map((item) => item.text).filter(Boolean).join("\n") ?? "";
  checks.push({
    name: `call:${name}`,
    status: call !== undefined && call.isError !== true && !call.error ? "passed" : name === "semantic_search" ? "failed" : "warning",
    detail: call === undefined ? "not captured" : call.error ?? (call.isError === true ? text || "provider returned isError" : "completed"),
  });
}
const graphCall = contract.calls?.graphrag;
checks.push({
  name: "tool:graphrag",
  status: toolNames.includes("graphrag") ? "passed" : "warning",
  detail: toolNames.includes("graphrag") ? "advertised" : graphCall?.reason ?? "not advertised; relationships remain unsupported",
});

for (const name of ["search", "symbols"]) {
  if (status(name) !== 0) continue;
  try {
    const value = JSON.parse(readFileSync(join(directory, `${name}.stdout`), "utf8")) as unknown;
    checks.push({ name: `${name}:results`, status: Array.isArray(value) && value.length > 0 ? "passed" : "failed", detail: Array.isArray(value) ? `${value.length} result(s)` : "output was not a JSON array" });
  } catch (error) {
    checks.push({ name: `${name}:results`, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
}
try {
  const environment = JSON.parse(readFileSync(join(directory, "embedding_environment.stdout"), "utf8")) as { configured?: boolean; guidance?: string };
  checks.push({ name: "embedding:configured", status: environment.configured === true ? "passed" : "failed", detail: environment.guidance ?? "configuration status unavailable" });
} catch (error) {
  checks.push({ name: "embedding:configured", status: "failed", detail: error instanceof Error ? error.message : String(error) });
}
try {
  const related = JSON.parse(readFileSync(join(directory, "related.stdout"), "utf8")) as { skipped?: boolean; reason?: string };
  if (related.skipped === true) checks.push({ name: "related:capability", status: "warning", detail: related.reason ?? "skipped" });
} catch {}
const totals = { passed: checks.filter((check) => check.status === "passed").length, warnings: checks.filter((check) => check.status === "warning").length, failed: checks.filter((check) => check.status === "failed").length };
const report = { provider: "octocode", version: "0.14.0", toolNames, totals, checks };
writeFileSync(join(directory, "conformance.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(directory, "CONFORMANCE.md"), ["# Octocode Conformance", "", `- Passed: ${totals.passed}`, `- Warnings: ${totals.warnings}`, `- Failed: ${totals.failed}`, "", ...checks.map((check) => `- ${check.status === "passed" ? "✓" : check.status === "warning" ? "⚠" : "✗"} ${check.name}: ${check.detail}`), ""].join("\n"));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = totals.failed === 0 ? 0 : 1;
