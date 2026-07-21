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
  "version", "help", "mcp_help", "index_help", "status_before", "index", "status_after",
  "mcp_contract", "search", "status_after_edit", "reindex_after_edit", "search_after_edit",
  "symbols", "evaluation",
]) {
  checkCommand(command);
}

const index = json("index") as { state?: unknown } | undefined;
checks.push({
  name: "index_ready",
  status: index?.state === "ready" ? "passed" : "failed",
  detail: `reported state: ${String(index?.state ?? "missing")}`,
});

for (const name of ["search", "symbols", "search_after_edit"] as const) {
  const status = exitStatus(name);
  const count = resultCount(name);
  checks.push({
    name: `${name}_results`,
    status: status !== 0 ? "failed" : (count ?? 0) > 0 ? "passed" : "warning",
    detail: status !== 0 ? `exit ${String(status)}` : `${String(count ?? "unknown")} normalized results`,
  });
}

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
