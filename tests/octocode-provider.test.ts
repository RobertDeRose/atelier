import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OctocodeProvider, type CodeWorkspace } from "../packages/core/src/index.ts";

const TEST_TOOL_TIMEOUT_MS = 10_000;

function fakeOctocode(root: string): { command: string; log: string } {
  const command = join(root, "octocode");
  const log = join(root, "calls.jsonl");
  writeFileSync(command, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === '--version') { console.log('octocode 0.14.0'); process.exit(0); }
if (args[0] === 'stats') { console.log(['Index Status', '  Files indexed: 3', '  Code blocks: 12', '  Text blocks: 0', '  Document blocks: 0', '  Commit blocks: 0', '', 'Configuration', '  Code model: voyage:voyage-code-3', '  Text model: voyage:voyage-3.5-lite'].join('\\n')); process.exit(0); }
if (args[0] === 'index') { console.log('Indexed 12 blocks'); process.exit(0); }
if (args[0] !== 'mcp') process.exit(2);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const i = buffer.indexOf('\\n'); const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (!('id' in request)) continue;
    let result = {};
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'octocode', version: '0.14.0' } };
    else if (request.method === 'tools/list') result = { tools: [
      { name: 'semantic_search', inputSchema: { type: 'object', properties: { query: { description: 'String or array of strings. Array preferred.' }, max_results: { type: 'number', maximum: 20 }, mode: { type: 'string' }, detail_level: { type: 'string' } } } },
      { name: 'view_signatures', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'graphrag', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get-relationships'] }, node_id: { type: 'string' }, limit: { type: 'number' }, depth: { type: 'number' } } } },
      { name: 'structural_search', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } }
    ] };
    else if (request.method === 'tools/call') {
      const { name, arguments: input } = request.params;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), tool: name, input }) + '\\n');
      if (name === 'semantic_search') result = { structuredContent: { results: [{ path: process.env.FAKE_OCTOCODE_RESULT_PATH ?? 'src/auth.ts', start_line: 2, end_line: 4, score: 0.91, signature: 'function refreshToken', content: 'export function refreshToken() {}' }] } };
      else if (name === 'graphrag') result = { structuredContent: { relationships: [{ type: 'imports', target_path: 'src/token.ts', description: 'token validation' }] } };
      else result = { structuredContent: {} };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`, "utf8");
  chmodSync(command, 0o755);
  return { command, log };
}

function workspace(roots: Array<{ id: string; root: string }>): CodeWorkspace {
  return {
    id: "work",
    name: "work",
    roots: roots.map((item) => item.root),
    repositories: roots.map((item) => ({
      id: item.id,
      name: item.id,
      root: item.root,
      snapshot: { repositoryId: item.id, workspaceId: "default", vcs: "git", headCommit: `${item.id}-head`, dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1 },
    })),
  };
}

test("Octocode adapter indexes and searches multiple repositories through isolated MCP processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-"));
  const a = join(root, "a"); const b = join(root, "b");
  mkdirSync(join(a, "src"), { recursive: true }); mkdirSync(join(b, "src"), { recursive: true });
  writeFileSync(join(a, "src", "auth.ts"), "export function refreshToken() {}\n", "utf8");
  writeFileSync(join(a, "src", "token.ts"), "export const token = true;\n", "utf8");
  writeFileSync(join(b, "src", "auth.ts"), "export function refreshToken() {}\n", "utf8");
  const fake = fakeOctocode(root);
  const provider = new OctocodeProvider({
    command: fake.command,
    cwd: root,
    timeoutMs: TEST_TOOL_TIMEOUT_MS,
    environment: { VOYAGE_API_KEY: "test-key" },
  });
  const work = workspace([{ id: "a", root: a }, { id: "b", root: b }]);
  try {
    assert.equal(await provider.ensureIndex(work), "ready");
    const status = await provider.status(work);
    assert.equal(status.available, true);
    assert.equal(status.healthy, true);
    assert.ok(status.capabilities.includes("graph.relationships"));
    assert.ok(status.capabilities.includes("index.multi_repository"));
    assert.ok(status.capabilities.includes("index.revision_aware"));
    assert.match(status.indexRevision ?? "", /^[a-f0-9]{64}$/);

    const hits = await provider.search({ workspace: work, text: "refresh token", mode: "auto", focus: "source", limit: 10, includeTests: true, includeGenerated: false });
    assert.equal(hits.length, 2);
    assert.deepEqual(new Set(hits.map((hit) => hit.repositoryId)), new Set(["a", "b"]));
    assert.equal(hits[0]?.provenance.provider.name, "octocode");

    const chunk = await provider.read(hits[0]!.reference);
    assert.match(chunk.content, /refreshToken/);

    const relationships = await provider.relationships({ workspace: work, reference: hits.find((hit) => hit.repositoryId === "a")!.reference, kinds: ["imports"], depth: 1, limit: 10 });
    assert.equal(relationships[0]?.kind, "imports");
    assert.equal(relationships[0]?.target.path, "src/token.ts");

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; args: string[]; tool?: string; input?: Record<string, unknown> });
    assert.equal(calls.filter((call) => call.args?.[0] === "index").length, 2);
    assert.ok(calls.some((call) => call.args?.[0] === "mcp" && realpathSync(call.cwd) === realpathSync(a)));
    assert.ok(calls.some((call) => call.args?.[0] === "mcp" && realpathSync(call.cwd) === realpathSync(b)));
    const searchCall = calls.find((call) => call.tool === "semantic_search") as { input?: Record<string, unknown> } | undefined;
    assert.deepEqual(searchCall?.input?.query, ["refresh token"]);
    assert.equal(searchCall?.input?.max_results, 20);
    assert.equal(searchCall?.input?.mode, "code");
    assert.equal(searchCall?.input?.detail_level, "partial");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Octocode marks results stale when source changes after indexing", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-stale-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "auth.ts"), "export function refreshToken() {}\n", "utf8");
  const fake = fakeOctocode(root);
  const provider = new OctocodeProvider({
    command: fake.command,
    cwd: root,
    timeoutMs: TEST_TOOL_TIMEOUT_MS,
    environment: { VOYAGE_API_KEY: "test-key" },
  });
  const indexedWorkspace = workspace([{ id: "repo", root: repo }]);
  const changedWorkspace = workspace([{ id: "repo", root: repo }]);
  indexedWorkspace.id = "actual-workspace";
  indexedWorkspace.name = "actual-workspace";
  changedWorkspace.id = "actual-workspace";
  changedWorkspace.name = "actual-workspace";
  changedWorkspace.repositories[0]!.snapshot = {
    ...changedWorkspace.repositories[0]!.snapshot,
    dirtyFingerprint: "changed-after-index",
  };
  try {
    assert.equal(await provider.ensureIndex(indexedWorkspace), "ready");
    const status = await provider.status(changedWorkspace);
    assert.equal(status.indexState, "stale");
    assert.equal(status.indexedRevisions?.repo, "git:repo-head:clean");

    const hits = await provider.search({
      workspace: changedWorkspace,
      text: "refresh token",
      mode: "semantic",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.equal(hits[0]?.provenance.workspaceId, "actual-workspace");
    assert.equal(hits[0]?.provenance.indexedRevision, "git:repo-head:clean");
    assert.equal(hits[0]?.provenance.currentRevision, "git:repo-head:changed-after-index");
    assert.equal(hits[0]?.provenance.freshness, "known_stale");
    assert.equal(hits[0]?.provenance.indexState, "stale");
    const chunk = await provider.read(hits[0]!.reference);
    assert.equal(chunk.provenance.workspaceId, "actual-workspace");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Octocode canonicalizes aliased repository roots and absolute result paths", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-canonical-"));
  const repositoryRoot = join(root, "repository");
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-octocode-canonical-alias-"));
  const aliasRoot = join(aliasParent, "repository");
  mkdirSync(join(repositoryRoot, "src"), { recursive: true });
  writeFileSync(join(repositoryRoot, "src", "auth.ts"), "export function refreshToken() {}\n", "utf8");
  symlinkSync(repositoryRoot, aliasRoot, "dir");
  const fake = fakeOctocode(root);
  const provider = new OctocodeProvider({
    command: fake.command,
    cwd: aliasRoot,
    timeoutMs: TEST_TOOL_TIMEOUT_MS,
    environment: {
      VOYAGE_API_KEY: "test-key",
      FAKE_OCTOCODE_RESULT_PATH: join(aliasRoot, "src", "auth.ts"),
    },
  });
  const work = workspace([{ id: "repo", root: aliasRoot }]);
  try {
    assert.equal(await provider.ensureIndex(work), "ready");
    const hits = await provider.search({
      workspace: work,
      text: "refresh token",
      mode: "semantic",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.equal(hits[0]?.path, "src/auth.ts");
    const chunk = await provider.read(hits[0]!.reference);
    assert.equal(chunk.path, "src/auth.ts");

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; args?: string[] });
    assert.ok(calls.some((call) => call.args?.[0] === "index" && call.cwd === realpathSync.native(repositoryRoot)));
    assert.equal(calls.some((call) => call.args?.some((arg) => arg.includes("../"))), false);
  } finally {
    await provider.close();
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test(
  "Octocode version probes preserve timeout diagnostics instead of reporting a missing executable",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "atlr-octocode-timeout-"));
    const command = join(root, "octocode-timeout");
    writeFileSync(command, "#!/bin/sh\nsleep 5\n", "utf8");
    chmodSync(command, 0o755);
    const provider = new OctocodeProvider({ command, cwd: root, timeoutMs: 100 });
    try {
      await assert.rejects(
        provider.ensureIndex(workspace([{ id: "repo", root }])),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /ETIMEDOUT|timed out/i);
          assert.doesNotMatch(message, /executable not found/i);
          return true;
        },
      );
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Octocode rejects cloud embedding configuration without the required API key before indexing", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-key-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const fake = fakeOctocode(root);
  const provider = new OctocodeProvider({
    command: fake.command,
    cwd: root,
    timeoutMs: TEST_TOOL_TIMEOUT_MS,
    environment: { VOYAGE_API_KEY: "" },
  });
  try {
    await assert.rejects(
      provider.ensureIndex(workspace([{ id: "repo", root: repo }])),
      /VOYAGE_API_KEY is not set/,
    );
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args?: string[] });
    assert.equal(calls.some((call) => call.args?.[0] === "index"), false);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Octocode retries a zero-block project with the supported bare index command", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-empty-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const command = join(root, "octocode-empty");
  const log = join(root, "calls-empty.jsonl");
  writeFileSync(command, String.raw`#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + '\n');
if (args[0] === '--version') { console.log('octocode 0.14.0'); process.exit(0); }
if (args[0] === 'stats') { const indexed = fs.existsSync(${JSON.stringify(join(root, 'indexed'))}); console.log('Code blocks: ' + (indexed ? '5' : '0') + '\nText blocks: 0\nDocument blocks: 0\nCommit blocks: 0\nCode model: fastembed:jinaai/jina-embeddings-v2-base-code\nText model: fastembed:nomic-ai/nomic-embed-text-v1.5'); process.exit(0); }
if (args[0] === 'index') { fs.writeFileSync(${JSON.stringify(join(root, 'indexed'))}, 'yes'); process.exit(0); }
if (args[0] === 'mcp') { let b=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { b+=c; while(b.includes('\n')) { const i=b.indexOf('\n'); const l=b.slice(0,i); b=b.slice(i+1); if(!l.trim()) continue; const r=JSON.parse(l); if(!('id' in r)) continue; const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'octocode',version:'0.14.0'}}:r.method==='tools/list'?{tools:[]}:{}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n'); }}); }
`, "utf8");
  chmodSync(command, 0o755);
  const provider = new OctocodeProvider({ command, cwd: root, timeoutMs: TEST_TOOL_TIMEOUT_MS });
  try {
    assert.equal(await provider.ensureIndex(workspace([{ id: "repo", root: repo }])), "ready");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
    assert.ok(calls.some((call) => call.args[0] === "index" && call.args.length === 1));
    assert.equal(calls.some((call) => call.args.includes("--force")), false);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
