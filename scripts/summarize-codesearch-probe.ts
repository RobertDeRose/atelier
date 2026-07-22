#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve(process.argv[2] ?? ".atelier/codesearch-probe");

type Check = { name: string; status: "passed" | "warning" | "failed"; detail: string };
const checks: Check[] = [];

function text(name: string, extension = "stdout"): string {
  const path = resolve(outputDirectory, `${name}.${extension}`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function exitStatus(name: string): number | undefined {
  const value = text(name, "status");
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function json(name: string): unknown {
  const value = text(name);
  if (!value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function resultCount(name: string): number | undefined {
  const value = json(name);
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    for (const key of ["results", "hits", "items", "matches"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate.length;
    }
  }
  return undefined;
}

function checkCommand(name: string): void {
  const status = exitStatus(name);
  checks.push({
    name,
    status: status === 0 ? "passed" : "failed",
    detail: status === undefined ? "missing exit status" : `exit ${status}`,
  });
}

for (const command of [
  "version", "help", "mcp_help", "index_help", "search_help",
  "status_before", "index", "status_after", "mcp_contract", "search", "search_literal",
  "status_after_edit", "reindex_after_edit", "search_after_edit", "symbols", "evaluation",
]) {
  checkCommand(command);
}
for (const diagnostic of ["codesearch_doctor", "codesearch_doctor_after", "codesearch_stats", "codesearch_stats_after", "direct_search", "store_metadata", "search_semantic"] as const) {
  const status = exitStatus(diagnostic);
  checks.push({
    name: `${diagnostic}_command`,
    status: status === 0 ? "passed" : "warning",
    detail: status === undefined ? "missing exit status" : `exit ${status}`,
  });
}

const index = json("index") as { state?: unknown } | undefined;
checks.push({
  name: "index_ready",
  status: index?.state === "ready" ? "passed" : "failed",
  detail: `reported state: ${String(index?.state ?? "missing")}`,
});

const vectorStatsBefore = parseVectorStats(text("codesearch_stats"));
const vectorStatsAfter = parseVectorStats(text("codesearch_stats_after"));
checks.push({
  name: "vector_index_built",
  status: vectorStatsAfter.indexed && vectorStatsAfter.totalChunks > 0 ? "passed" : "failed",
  detail: vectorStatsAfter.indexed
    ? `indexed with ${vectorStatsAfter.totalChunks} chunks`
    : `not indexed (${vectorStatsAfter.totalChunks} chunks)`,
});
if (!vectorStatsBefore.indexed && vectorStatsAfter.indexed) {
  checks.push({
    name: "vector_index_repaired",
    status: "passed",
    detail: `repaired an unbuilt vector index containing ${vectorStatsBefore.totalChunks} chunks`,
  });
}

for (const name of ["search", "search_literal", "symbols", "search_after_edit"] as const) {
  const status = exitStatus(name);
  const count = resultCount(name);
  checks.push({
    name: `${name}_results`,
    status: status !== 0 ? "failed" : (count ?? 0) > 0 ? "passed" : "warning",
    detail: status !== 0 ? `exit ${String(status)}` : `${String(count ?? "unknown")} normalized results`,
  });
}

const pollutedPaths = ["search", "search_semantic", "search_literal", "search_after_edit"]
  .flatMap((name) => normalizedResultPaths(json(name)))
  .filter((path) => path.replaceAll("\\", "/").includes("tests/fixtures/codesearch-"));
checks.push({
  name: "fixture_pollution",
  status: pollutedPaths.length === 0 ? "passed" : "failed",
  detail: pollutedPaths.length === 0
    ? "captured provider results exclude committed codesearch fixtures"
    : `provider returned ignored fixture paths: ${[...new Set(pollutedPaths)].slice(0, 5).join(", ")}`,
});

const focusedSearchPaths = normalizedResultPaths(json("search"));
const firstProductSourceRank = focusedSearchPaths.findIndex((path) => isProductSourcePath(path));
checks.push({
  name: "implementation_focus",
  status: firstProductSourceRank >= 0 && firstProductSourceRank < 3 ? "passed" : "warning",
  detail: firstProductSourceRank >= 0
    ? `first product source path ranked ${firstProductSourceRank + 1}: ${focusedSearchPaths[firstProductSourceRank]}`
    : "implementation query returned no product source path",
});

const evaluation = jsonFromPath(resolve(outputDirectory, "evaluation", "latest.json")) as {
  aggregate?: {
    baseline?: { meanWeightedRecall?: unknown };
    codesearch?: { meanWeightedRecall?: unknown };
  };
} | undefined;
const baselineRecall = numeric(evaluation?.aggregate?.baseline?.meanWeightedRecall);
const codesearchRecall = numeric(evaluation?.aggregate?.codesearch?.meanWeightedRecall);
checks.push({
  name: "retrieval_quality",
  status: codesearchRecall !== undefined && codesearchRecall >= 0.5 ? "passed" : "warning",
  detail: codesearchRecall === undefined
    ? "evaluation did not report mean weighted recall"
    : `codesearch mean weighted recall ${codesearchRecall.toFixed(4)}${baselineRecall === undefined ? "" : `; baseline ${baselineRecall.toFixed(4)}`}`,
});

const mcpContract = json("mcp_contract") as {
  tools?: Array<{ name?: unknown }>;
  statusHistory?: Array<{ state?: unknown }>;
  calls?: Record<string, unknown>;
} | undefined;
const toolNames = mcpContract?.tools?.map((tool) => String(tool.name)).filter(Boolean) ?? [];

const rawReady = mcpContract?.statusHistory?.some((entry) => entry.state === "ready") ?? false;
checks.push({
  name: "mcp_index_ready",
  status: rawReady ? "passed" : "failed",
  detail: rawReady
    ? `ready after ${String(mcpContract?.statusHistory?.length ?? 0)} status observation(s)`
    : `states: ${mcpContract?.statusHistory?.map((entry) => String(entry.state)).join(", ") || "missing"}`,
});

for (const required of ["status", "search", "find", "get_chunk"]) {
  checks.push({
    name: `mcp_tool_${required}`,
    status: toolNames.includes(required) ? "passed" : "failed",
    detail: toolNames.includes(required) ? "advertised" : `missing; advertised: ${toolNames.join(", ") || "none"}`,
  });
}
for (const optional of ["explore", "find_impact"]) {
  checks.push({
    name: `mcp_tool_${optional}`,
    status: toolNames.includes(optional) ? "passed" : "warning",
    detail: toolNames.includes(optional) ? "advertised" : `optional tool unavailable; advertised: ${toolNames.join(", ") || "none"}`,
  });
}

type ToolPayload = { isError?: unknown; content?: Array<{ text?: unknown }>; structuredContent?: unknown };

const semanticPayload = json("semantic") as ToolPayload | undefined;
const hybridPayload = json("hybrid") as ToolPayload | undefined;
const literalPayload = json("literal") as ToolPayload | undefined;
for (const [name, payload, required] of [
  ["semantic_health", semanticPayload, false],
  ["hybrid_health", hybridPayload, false],
  ["literal_health", literalPayload, true],
] as const) {
  const error = providerError(payload);
  const count = toolResultCount(payload);
  checks.push({
    name,
    status: error !== undefined ? (required ? "failed" : "warning") : count > 0 ? "passed" : "warning",
    detail: error ?? `${count} raw result(s)`,
  });
}

const fetchPayload = json("fetch") as ToolPayload | undefined;
const fetchText = toolText(fetchPayload);
checks.push({
  name: "fetch_result",
  status: !toolNames.includes("get_chunk") ? "failed" : fetchPayload === undefined ? "warning" : fetchPayload.isError === true || !fetchText ? "failed" : "passed",
  detail: !toolNames.includes("get_chunk")
    ? "required get_chunk tool unavailable"
    : fetchPayload === undefined
      ? "search returned no fetchable chunk"
      : fetchPayload.isError === true
        ? fetchText || "provider returned isError"
        : fetchText
          ? `${Buffer.byteLength(fetchText)} bytes`
          : "missing content",
});

const outlinePayload = json("outline") as ToolPayload | undefined;
const outlineText = toolText(outlinePayload);
checks.push({
  name: "outline_result",
  status: !toolNames.includes("explore") || outlinePayload === undefined
    ? "warning"
    : outlinePayload.isError === true || !outlineText
      ? "failed"
      : "passed",
  detail: !toolNames.includes("explore")
    ? "optional explore tool unavailable"
    : outlinePayload === undefined
      ? "optional outline call not captured"
      : outlinePayload.isError === true
        ? outlineText || "provider returned isError"
        : outlineText
          ? `${Buffer.byteLength(outlineText)} bytes`
          : "missing content",
});

const impactPayload = json("impact") as ToolPayload | undefined;
const impactText = toolText(impactPayload);
const impactUnavailable = /No symbol indexers installed|symbol index(?:er)? unavailable|install the .* helper/i.test(impactText);
checks.push({
  name: "impact_result",
  status: !toolNames.includes("find_impact") || impactPayload === undefined || impactUnavailable
    ? "warning"
    : impactPayload.isError === true || !impactText
      ? "failed"
      : "passed",
  detail: !toolNames.includes("find_impact")
    ? "optional find_impact tool unavailable"
    : impactPayload === undefined
      ? "optional impact call not captured"
      : impactUnavailable
        ? impactText
        : impactPayload.isError === true
          ? impactText || "provider returned isError"
          : impactText
            ? `${Buffer.byteLength(impactText)} bytes`
            : "missing content",
});



function jsonFromPath(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return undefined; }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProductSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (/^(?:tests?|specs?|docs?|scripts?|tools?)\//.test(normalized)) return false;
  if (/(?:^|\/)(?:readme|changelog|contributing|license)(?:\.[^/]*)?$/.test(normalized)) return false;
  return /\.(?:c|cc|cpp|cs|ex|exs|go|h|hpp|java|js|jsx|kt|kts|lua|php|py|rb|rs|sh|swift|ts|tsx|vue|zig)$/.test(normalized);
}

function normalizedResultPaths(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).results)
      ? (value as Record<string, unknown>).results as unknown[]
      : [];
  return rows.flatMap((row) => row && typeof row === "object" && typeof (row as Record<string, unknown>).path === "string"
    ? [(row as Record<string, unknown>).path as string]
    : []);
}

function parseVectorStats(value: string): { totalChunks: number; indexed: boolean } {
  const normalized = value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
  return {
    totalChunks: Number(normalized.match(/Total chunks:\s*(\d+)/i)?.[1] ?? "0"),
    indexed: /Indexed:\s*[^\n]*\bYes\b/i.test(normalized),
  };
}

function providerError(payload: ToolPayload | undefined): string | undefined {
  const value = toolText(payload).trim();
  if (payload?.isError === true) return value || "provider returned isError";
  return /^(?:error|failed)\b/i.test(value) || /error (?:searching|opening|reading|querying)|vector store.*(?:error|failed)|database.*(?:error|failed)/i.test(value)
    ? value
    : undefined;
}

function toolResultCount(payload: ToolPayload | undefined): number {
  if (payload === undefined) return 0;
  const textValue = toolText(payload);
  try {
    const parsed = JSON.parse(textValue) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") {
      for (const key of ["results", "hits", "items", "matches"]) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return candidate.length;
      }
    }
  } catch { /* provider diagnostic text */ }
  return 0;
}

function toolText(payload: ToolPayload | undefined): string {
  if (payload === undefined) return "";
  const content = payload.content?.map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n") ?? "";
  if (content) return content;
  if (payload.structuredContent === undefined) return "";
  return typeof payload.structuredContent === "string"
    ? payload.structuredContent
    : JSON.stringify(payload.structuredContent);
}

const totals = {
  passed: checks.filter((check) => check.status === "passed").length,
  warnings: checks.filter((check) => check.status === "warning").length,
  failed: checks.filter((check) => check.status === "failed").length,
};
const summary = { generatedAt: new Date().toISOString(), outputDirectory, totals, checks };
writeFileSync(resolve(outputDirectory, "conformance.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  resolve(outputDirectory, "CONFORMANCE.md"),
  [
    "# Codesearch Conformance",
    "",
    `- Passed: ${totals.passed}`,
    `- Warnings: ${totals.warnings}`,
    `- Failed: ${totals.failed}`,
    "",
    ...checks.map((check) => `- ${check.status === "passed" ? "✓" : check.status === "warning" ? "⚠" : "✗"} ${check.name}: ${check.detail}`),
    "",
  ].join("\n"),
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = totals.failed > 0 ? 1 : 0;
