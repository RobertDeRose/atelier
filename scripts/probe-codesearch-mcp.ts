#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { McpStdioClient, type McpToolCallResult } from "../packages/core/src/index.ts";

const root = resolve(process.argv[2] ?? process.cwd());
const timeoutMs = Number(process.env.ATLR_CODE_INDEX_TIMEOUT_MS ?? 300_000);
const pollIntervalMs = Number(process.env.ATLR_CODE_POLL_INTERVAL_MS ?? 1_000);
const client = new McpStdioClient("codesearch", ["mcp"], { cwd: root, timeoutMs: 60_000 });

try {
  const initialize = await client.initialize({ clientName: "atelier-probe", clientVersion: "0.7.1" });
  const tools = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  const statusHistory: Array<{ observedAt: string; state: string; response: McpToolCallResult }> = [];

  if (toolNames.has("status")) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await client.callTool("status", { kind: "index" });
      const state = inferIndexState(response);
      statusHistory.push({ observedAt: new Date().toISOString(), state, response });
      if (state === "ready") break;
      if (state === "failed" || state === "missing") {
        throw new Error(`codesearch index is ${state}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`codesearch index did not become ready within ${timeoutMs} ms (last state: ${state})`);
      }
      await delay(pollIntervalMs);
    }
  }

  const search = toolNames.has("search")
    ? await client.callTool("search", {
        query: "where is code provider selection implemented",
        mode: "semantic",
        semantic_mode: "auto",
        compact: true,
        limit: 5,
      })
    : undefined;
  const symbols = toolNames.has("find")
    ? await client.callTool("find", { symbol: "CodesearchProvider", kind: "definition", limit: 5 })
    : undefined;
  const firstChunk = findFirstChunk(search);
  const fetch = toolNames.has("get_chunk") && firstChunk !== undefined
    ? await client.callTool("get_chunk", firstChunk.chunkRef === undefined ? { chunk_id: firstChunk.chunkId, context_lines: 0 } : { chunk_ref: firstChunk.chunkRef, context_lines: 0 })
    : undefined;
  const outline = toolNames.has("explore")
    ? await client.callTool("explore", { kind: "outline", target: "packages/core/src/code/codesearch-provider.ts", limit: 20 })
    : undefined;
  const impact = toolNames.has("find_impact")
    ? await client.callTool("find_impact", { symbol_name: "CodesearchProvider" })
    : undefined;

  process.stdout.write(`${JSON.stringify({ initialize, tools, statusHistory, calls: { search, symbols, fetch, outline, impact } }, null, 2)}\n`);
} finally {
  await client.close();
}

function inferIndexState(result: McpToolCallResult): string {
  const data = result.structuredContent ?? parseText(result);
  const explicit = findStatus(data);
  if (explicit !== undefined) return explicit;
  const text = collectStrings(data).join("\n").toLowerCase();
  if (/database:\s+.+\(ready\)/.test(text) || /\bready\b/.test(text)) return "ready";
  if (/\b(building|indexing)\b/.test(text)) return "building";
  if (/\b(error|failed)\b/.test(text)) return "failed";
  if (/not[_ ]indexed|\bmissing\b/.test(text)) return "missing";
  return "unknown";
}

function parseText(result: McpToolCallResult): unknown {
  const text = result.content?.map((item) => item.text).filter((value): value is string => typeof value === "string").join("\n") ?? "";
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return { text }; }
}

function findStatus(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = findStatus(item);
      if (status !== undefined) return status;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["index_state", "indexState", "status", "state"]) {
    if (typeof record[key] !== "string") continue;
    const normalized = normalizeState(record[key]);
    if (normalized !== undefined) return normalized;
  }
  for (const item of Object.values(record)) {
    const status = findStatus(item);
    if (status !== undefined) return status;
  }
  return undefined;
}

function normalizeState(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("ready") || normalized === "indexed" || normalized === "ok") return "ready";
  if (normalized.includes("build") || normalized.includes("indexing")) return "building";
  if (normalized.includes("error") || normalized.includes("fail")) return "failed";
  if (normalized.includes("not_indexed") || normalized.includes("not indexed") || normalized.includes("missing")) return "missing";
  return undefined;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  return [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function findFirstChunk(result: McpToolCallResult | undefined): { chunkId: number; chunkRef?: string } | undefined {
  if (result === undefined) return undefined;
  const data = result.structuredContent ?? parseText(result);
  const rows = findRows(data);
  for (const row of rows) {
    const chunkId = row.chunk_id ?? row.chunkId;
    const chunkRef = typeof row.chunk_ref === "string" ? row.chunk_ref : typeof row.chunkRef === "string" ? row.chunkRef : undefined;
    if (typeof chunkId === "number") return { chunkId, ...(chunkRef === undefined ? {} : { chunkRef }) };
  }
  return undefined;
}

function findRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["results", "hits", "items", "matches"]) {
    if (Array.isArray(record[key])) return findRows(record[key]);
  }
  for (const item of Object.values(record)) { const rows = findRows(item); if (rows.length) return rows; }
  return [];
}
