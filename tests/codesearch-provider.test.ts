import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodesearchProvider, type CodeWorkspace } from "../packages/core/src/index.ts";

function fakeCodesearch(root: string): { command: string; log: string; mcpLog: string } {
  const command = join(root, "codesearch");
  const log = join(root, "calls.jsonl");
  const mcpLog = join(root, "mcp-calls.jsonl");
  writeFileSync(command, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('codesearch 1.1.30'); process.exit(0); }
if (args[0] === 'index') { console.log('indexed'); process.exit(0); }
if (args[0] === 'stats') {
  const indexed = process.env.FAKE_STATS_INDEXED !== '0';
  console.log('Vector Store:');
  console.log('   Total chunks: 42');
  console.log('   Total files: 4');
  console.log('   Indexed: ' + (indexed ? '✅ Yes' : '❌ No'));
  process.exit(0);
}
if (args[0] !== 'mcp') process.exit(2);
let buffer = '';
let statusCalls = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (!('id' in request)) continue;
    fs.appendFileSync(${JSON.stringify(mcpLog)}, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codesearch', version: '1.1.30' }, instructions: 'Prefer semantic search.' };
    else if (request.method === 'tools/list') result = { tools: ['search','find','get_chunk','status','explore','find_impact'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (request.method === 'tools/call') {
      const { name, arguments: input } = request.params;
      if (name === 'status') {
        statusCalls += 1;
        const buildingCalls = Number(process.env.FAKE_BUILDING_STATUS_COUNT ?? '0');
        result = { structuredContent: statusCalls <= buildingCalls ? { index_state: 'building' } : { index_state: 'ready', index_age_seconds: 3 } };
      }
      else if (name === 'search' && input.mode === 'semantic' && process.env.FAKE_SEMANTIC_ERROR === '1') result = { content: [{ type: 'text', text: 'Error searching vector store: Error opening database for read fallback' }], isError: false };
      else if (name === 'search') result = { structuredContent: { index_state: 'ready', results: [{ chunk_id: 42, project: input.project ?? 'repo', path: process.env.FAKE_RESULT_PATH ?? 'src/auth.ts', start_line: 10, end_line: 14, language: 'typescript', symbol: 'refreshToken', score: 0.91, preview: 'export function refreshToken()' }] } };
      else if (name === 'find') result = { structuredContent: { results: [{ chunk_id: 43, project: input.project ?? 'repo', path: process.env.FAKE_RESULT_PATH ?? 'src/auth.ts', start_line: 10, end_line: 14, symbol: input.symbol, kind: input.kind }] } };
      else if (name === 'get_chunk') result = { structuredContent: { chunk: { chunk_id: input.chunk_id, project: input.project, path: process.env.FAKE_RESULT_PATH ?? 'src/auth.ts', start_line: 10, end_line: 14, language: 'typescript', content: 'export function refreshToken() { return token; }' } } };
      else if (name === 'explore') result = { structuredContent: { results: [{ chunk_id: 44, path: input.target, start_line: 1, end_line: 20, kind: 'Class', signature: 'class CodesearchProvider' }] } };
      else if (name === 'find_impact') result = { structuredContent: { results: [{ chunk_id: 45, path: 'src/caller.ts', line: 3, kind: 'Call', signature: 'refreshToken()' }] } };
      else result = { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    } else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`, "utf8");
  chmodSync(command, 0o755);
  return { command, log, mcpLog };
}

function workspace(root: string): CodeWorkspace {
  return {
    id: "work",
    name: "work",
    roots: [root],
    repositories: [{
      id: "repo",
      name: "repo",
      root,
      snapshot: {
        repositoryId: "repo",
        workspaceId: "default",
        vcs: "jj",
        headCommit: "abc",
        changeId: "change",
        operationId: "op",
        dirtyGeneration: 0,
        dirtyFingerprint: "clean",
        indexSchemaVersion: 1,
      },
    }],
  };
}

test("codesearch adapter negotiates MCP tools and normalizes search, fetch, and symbol results", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_BUILDING_STATUS_COUNT: "2", FAKE_RESULT_PATH: join(root, "src", "auth.ts") },
  });
  try {
    const indexed = await provider.ensureIndex(workspace(root));
    assert.equal(indexed, "ready");

    const status = await provider.status();
    assert.equal(status.available, true);
    assert.equal(status.healthy, true);
    assert.equal(status.identity.version, "1.1.30");
    assert.ok(status.capabilities.includes("search.semantic"));
    assert.ok(status.capabilities.includes("result.fetch_on_demand"));
    assert.equal(status.capabilities.includes("index.multi_repository"), false);

    const hits = await provider.search({
      workspace: workspace(root),
      text: "refresh token",
      mode: "hybrid",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.repositoryId, "repo");
    assert.equal(hits[0]?.symbol, "refreshToken");
    assert.equal(hits[0]?.path, "src/auth.ts");
    assert.equal(hits[0]?.reference.path, "src/auth.ts");
    assert.equal(hits[0]?.provenance.provider.name, "codesearch");
    assert.equal(hits[0]?.provenance.indexState, "ready");
    assert.equal(hits[0]?.provenance.freshness, "current");


    const changedWorkspace = workspace(root);
    changedWorkspace.repositories[0]!.snapshot.dirtyFingerprint = "changed";
    const staleHits = await provider.search({
      workspace: changedWorkspace, text: "refresh token", mode: "semantic", limit: 5, includeTests: true, includeGenerated: false,
    });
    assert.equal(staleHits[0]?.provenance.freshness, "known_stale");

    const callsRelationships = await provider.relationships({
      workspace: changedWorkspace, reference: hits[0]!.reference, kinds: ["calls"], depth: 1, limit: 5,
    });
    assert.equal(callsRelationships[0]?.kind, "calls");
    assert.ok(status.capabilities.includes("graph.impact"));
    assert.ok(status.capabilities.includes("file.outline"));

    const chunk = await provider.read(hits[0]!.reference);
    assert.match(chunk.content, /refreshToken/);
    assert.equal(chunk.path, "src/auth.ts");
    assert.equal(chunk.reference.path, "src/auth.ts");

    const symbols = await provider.symbols({ workspace: workspace(root), text: "refreshToken", limit: 5 });
    assert.equal(symbols[0]?.path, "src/auth.ts");

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === root));
    assert.ok(calls.some((args) => args[0] === "stats" && args[1] === root));
    assert.equal(calls.some((args) => args[0] === "index" && args[1] === "add"), false);
    assert.ok(calls.some((args) => args[0] === "mcp" && args.includes("local")));

    const mcpCalls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searchCall = mcpCalls.find((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searchCall?.params?.arguments?.project, undefined);
    assert.equal(searchCall?.params?.arguments?.group, undefined);
    assert.equal(searchCall?.params?.arguments?.mode, "semantic");
    assert.equal(searchCall?.params?.arguments?.semantic_mode, "hybrid");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch client mode uses configured project aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-client-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    mode: "client",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
  });
  const configuredWorkspace = workspace(root);
  configuredWorkspace.repositories[0]!.codesearchProject = "atelier-api";
  try {
    const indexed = await provider.ensureIndex(configuredWorkspace);
    assert.equal(indexed, "ready");
    await provider.search({
      workspace: configuredWorkspace,
      text: "refresh token",
      mode: "semantic",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    const processCalls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(processCalls.some((args) => args[0] === "index" && args[1] === "add" && args[2] === root));

    const mcpCalls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const statusCall = mcpCalls.find((call) => call.method === "tools/call" && call.params?.name === "status");
    assert.equal(statusCall?.params?.arguments?.project, "atelier-api");
    const searchCall = mcpCalls.find((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searchCall?.params?.arguments?.project, "atelier-api");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch auto search degrades to bounded literal retrieval when semantic storage fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-fallback-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_SEMANTIC_ERROR: "1" },
  });
  try {
    const hits = await provider.search({
      workspace: workspace(root),
      text: "where is code provider selection implemented",
      mode: "auto",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.provenance.actualMode, "lexical");
    assert.equal(hits[0]?.provenance.degraded, true);
    assert.match(hits[0]?.provenance.warnings?.[0] ?? "", /Error opening database for read fallback/);
    assert.ok(hits[0]?.provenance.postProcessing.some((item) => item.includes("literal fallback")));

    const status = await provider.status(workspace(root));
    assert.equal(status.degraded, true);
    assert.match(status.warnings?.[0] ?? "", /vector store/);

    const calls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searches = calls.filter((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searches[0]?.params?.arguments?.mode, "semantic");
    assert.ok(searches.slice(1).some((call) => call.params?.arguments?.mode === "literal"));
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit semantic search surfaces provider operational errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-semantic-error-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_SEMANTIC_ERROR: "1" },
  });
  try {
    await assert.rejects(provider.search({
      workspace: workspace(root),
      text: "provider selection",
      mode: "semantic",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    }), /codesearch semantic search failed.*Error opening database for read fallback/);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch local indexing rejects an unbuilt vector index even when MCP reports ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-unbuilt-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_STATS_INDEXED: "0" },
  });
  try {
    await assert.rejects(
      provider.ensureIndex(workspace(root)),
      /vector store contains 42 chunks but the HNSW index is not built/,
    );
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === root));
    assert.ok(calls.some((args) => args[0] === "stats" && args[1] === root));
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
