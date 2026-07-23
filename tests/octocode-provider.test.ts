import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OctocodeProvider, type CodeWorkspace } from "../packages/core/src/index.ts";

function fakeOctocode(root: string): { command: string; log: string } {
  const command = join(root, "octocode");
  const log = join(root, "calls.jsonl");
  writeFileSync(command, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === '--version') { console.log('octocode 0.14.0'); process.exit(0); }
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
      { name: 'semantic_search', inputSchema: { type: 'object', properties: { query: { description: 'String or array of strings. Array preferred.' }, max_results: { type: 'number' }, mode: { type: 'string' }, detail_level: { type: 'string' } } } },
      { name: 'view_signatures', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'graphrag', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get-relationships'] }, node_id: { type: 'string' }, limit: { type: 'number' }, depth: { type: 'number' } } } },
      { name: 'structural_search', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } }
    ] };
    else if (request.method === 'tools/call') {
      const { name, arguments: input } = request.params;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), tool: name, input }) + '\\n');
      if (name === 'semantic_search') result = { structuredContent: { results: [{ path: 'src/auth.ts', start_line: 2, end_line: 4, score: 0.91, signature: 'function refreshToken', content: 'export function refreshToken() {}' }] } };
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
  const provider = new OctocodeProvider({ command: fake.command, cwd: root, timeoutMs: 2_000 });
  const work = workspace([{ id: "a", root: a }, { id: "b", root: b }]);
  try {
    assert.equal(await provider.ensureIndex(work), "ready");
    const status = await provider.status(work);
    assert.equal(status.available, true);
    assert.equal(status.healthy, true);
    assert.ok(status.capabilities.includes("graph.relationships"));
    assert.ok(status.capabilities.includes("index.multi_repository"));

    const hits = await provider.search({ workspace: work, text: "refresh token", mode: "auto", limit: 10, includeTests: true, includeGenerated: false });
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
    assert.equal(searchCall?.input?.max_results, 10);
    assert.equal(searchCall?.input?.mode, "all");
    assert.equal(searchCall?.input?.detail_level, "partial");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
