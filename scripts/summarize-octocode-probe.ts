import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: summarize-octocode-probe.ts DIRECTORY");
const required = ["version", "index", "stats", "adapter_index", "providers", "status", "search", "symbols", "mcp_contract"];
const optional = ["related"];
const checks: Array<{ name: string; status: "passed" | "warning" | "failed"; detail: string }> = [];
const exit = (name: string) => Number(readFileSync(join(directory, `${name}.status`), "utf8").trim());
for (const name of required) {
  const code = existsSync(join(directory, `${name}.status`)) ? exit(name) : 127;
  checks.push({ name, status: code === 0 ? "passed" : "failed", detail: `exit ${code}` });
}
for (const name of optional) {
  const code = existsSync(join(directory, `${name}.status`)) ? exit(name) : 127;
  checks.push({ name, status: code === 0 ? "passed" : "warning", detail: code === 0 ? "available or explicitly skipped" : `exit ${code}` });
}
const contract = JSON.parse(readFileSync(join(directory, "mcp_contract.stdout"), "utf8")) as {
  tools?: Array<{ name?: string }>;
  calls?: Record<string, { isError?: boolean; skipped?: boolean; reason?: string; content?: Array<{ text?: string }> }>;
};
const toolNames = (contract.tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string");
for (const name of ["semantic_search", "view_signatures", "structural_search"]) {
  const advertised = toolNames.includes(name);
  checks.push({ name: `tool:${name}`, status: advertised ? "passed" : "warning", detail: advertised ? "advertised" : "not advertised" });
  if (advertised) {
    const call = contract.calls?.[name];
    const detail = call?.content?.map((item) => item.text).filter(Boolean).join("\n") ?? "";
    checks.push({ name: `call:${name}`, status: call !== undefined && call.isError !== true ? "passed" : "failed", detail: call === undefined ? "not captured" : call.isError === true ? detail || "provider returned isError" : "completed" });
  }
}
const graphCall = contract.calls?.graphrag;
checks.push({
  name: "tool:graphrag",
  status: toolNames.includes("graphrag") ? "passed" : "warning",
  detail: toolNames.includes("graphrag") ? "advertised" : graphCall?.reason ?? "not advertised; relationships remain unsupported",
});
for (const name of ["search", "symbols"]) {
  try {
    const value = JSON.parse(readFileSync(join(directory, `${name}.stdout`), "utf8")) as unknown;
    checks.push({ name: `${name}:results`, status: Array.isArray(value) && value.length > 0 ? "passed" : "failed", detail: Array.isArray(value) ? `${value.length} result(s)` : "output was not a JSON array" });
  } catch (error) {
    checks.push({ name: `${name}:results`, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
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
