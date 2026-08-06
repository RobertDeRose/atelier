import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodesearchProvider, parseCodesearchLockOutput, type CodeWorkspace } from "../packages/core/src/index.ts";

function fakeCodesearch(root: string): { command: string; log: string; mcpLog: string } {
  const command = join(root, "codesearch");
  const log = join(root, "calls.jsonl");
  const mcpLog = join(root, "mcp-calls.jsonl");
  const mcpLock = join(root, "mcp-writer.lock");
  writeFileSync(command, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const mcpLock = ${JSON.stringify(mcpLock)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('codesearch 1.1.30'); process.exit(0); }
if (args[0] === 'index') {
  if (process.env.FAKE_INDEX_LOCKED === '1') {
    console.error('Failed to acquire Lockfile: LockBusy');
    process.exit(1);
  }
  if (process.env.FAKE_MCP_LOCK === '1' && fs.existsSync(mcpLock)) {
    console.error('Failed to acquire Lockfile: LockBusy');
    process.exit(1);
  }
  fs.mkdirSync(${JSON.stringify(join(root, '.codesearch.db'))}, { recursive: true });
  if (process.env.FAKE_INDEX_HANG === '1') {
    console.error('index started but stalled');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  console.log('indexed'); process.exit(0);
}
if (args[0] === 'stats') {
  const indexed = process.env.FAKE_STATS_INDEXED !== '0';
  const chunks = Number(process.env.FAKE_STATS_CHUNKS ?? '42');
  console.log('Vector Store:');
  console.log('   Total chunks: ' + chunks);
  console.log('   Total files: ' + (chunks > 0 ? '4' : '0'));
  console.log('   Indexed: ' + (indexed && chunks > 0 ? '✅ Yes' : '❌ No'));
  process.exit(0);
}
if (args[0] !== 'mcp') process.exit(2);
if (process.env.FAKE_MCP_CREATES_DB === '1') fs.mkdirSync(${JSON.stringify(join(root, '.codesearch.db'))}, { recursive: true });
if (process.env.FAKE_MCP_LOCK === '1') fs.writeFileSync(mcpLock, String(process.pid));
const cleanup = () => { try { fs.rmSync(mcpLock, { force: true }); } catch {} };
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
process.stdin.on('end', () => { cleanup(); process.exit(0); });
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
        result = process.env.FAKE_STATUS_ERROR === '1'
          ? { structuredContent: { indexed: false, status: 'not indexed', status_message: 'Error opening readonly database for read fallback', error_message: 'Error opening readonly database for read fallback' } }
          : { structuredContent: process.env.FAKE_OPTIONAL_STATUS_ERROR === '1'
            ? { database: 'project database (ready)', optional_indexer: { status: 'error', detail: 'SCIP unavailable' } }
            : statusCalls <= buildingCalls ? { index_state: 'building' } : { index_state: 'ready', index_age_seconds: 3 } };
      }
      else if (name === 'search' && input.mode === 'semantic' && process.env.FAKE_SEMANTIC_ERROR === '1') result = { content: [{ type: 'text', text: 'Error searching vector store: Error opening database for read fallback' }], isError: false };
      else if (name === 'search') {
        const source = input.mode === 'literal' ? process.env.FAKE_LITERAL_ROWS : process.env.FAKE_SEMANTIC_ROWS;
        const configured = source ? JSON.parse(source) : process.env.FAKE_SEARCH_ROWS ? JSON.parse(process.env.FAKE_SEARCH_ROWS) : [{ chunk_id: 42, project: input.project ?? 'repo', path: process.env.FAKE_RESULT_PATH ?? 'src/auth.ts', start_line: 10, end_line: 14, language: 'typescript', symbol: 'refreshToken', score: 0.91, preview: 'export function refreshToken()' }];
        result = { structuredContent: { index_state: 'ready', results: configured.slice(0, Number(input.limit ?? 10)) } };
      }
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

function fakeLsof(root: string, output: string): string {
  const command = join(root, "lsof");
  writeFileSync(command, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
  chmodSync(command, 0o755);
  return command;
}

function canonicalRoot(root: string): string {
  return realpathSync.native(root);
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

test("codesearch lock output groups holders and excludes ignored provider processes", () => {
  const output = [
    "p1234",
    "ccodesearch",
    "n/workspace/.codesearch.db/lock.mdb",
    "p5678",
    "cpi",
    "n/workspace/.codesearch.db/.writer.lock",
    "n/workspace/.codesearch.db/fts/.tantivy-writer.lock",
    "n/workspace/.codesearch.db/data.mdb",
  ].join("\n");
  assert.deepEqual(parseCodesearchLockOutput(output, [1234]), [{
    pid: 5678,
    command: "pi",
    paths: [
      "/workspace/.codesearch.db/.writer.lock",
      "/workspace/.codesearch.db/fts/.tantivy-writer.lock",
      "/workspace/.codesearch.db/data.mdb",
    ],
  }]);
});

test("codesearch adapter negotiates MCP tools and normalizes search, fetch, and symbol results", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
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
    assert.equal(status.capabilities.includes("index.revision_aware"), true);
    assert.match(status.indexRevision ?? "", /^[a-f0-9]{64}$/);

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
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === canonicalRoot(root)));
    assert.ok(calls.some((args) => args[0] === "stats" && args[1] === canonicalRoot(root)));
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


test("codesearch canonicalizes workspace aliases and absolute provider result paths", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-canonical-root-"));
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-codesearch-canonical-alias-"));
  const aliasRoot = join(aliasParent, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), "export function refreshToken() { return token; }\n", "utf8");
  symlinkSync(root, aliasRoot, "dir");
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: aliasRoot,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_RESULT_PATH: join(aliasRoot, "src", "auth.ts") },
  });
  try {
    const aliasedWorkspace = workspace(aliasRoot);
    assert.equal(await provider.ensureIndex(aliasedWorkspace), "ready");
    const hits = await provider.search({
      workspace: aliasedWorkspace,
      text: "refresh token",
      mode: "semantic",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.equal(hits[0]?.path, "src/auth.ts");
    assert.equal(hits[0]?.reference.path, "src/auth.ts");

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === realpathSync.native(root)));
    assert.equal(calls.some((args) => args.some((arg) => arg.includes("../"))), false);
  } finally {
    await provider.close();
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch rejects provider paths that escape the repository boundary", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-path-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "atlr-codesearch-path-outside-"));
  writeFileSync(join(outside, "secret.txt"), "outside secret\n", "utf8");
  symlinkSync(outside, join(root, "escape"), "dir");
  const fake = fakeCodesearch(root);
  const paths = ["../secret.txt", join(outside, "secret.txt"), "escape/secret.txt"];
  try {
    for (const [index, providerPath] of paths.entries()) {
      const provider = new CodesearchProvider({
        command: fake.command,
        cwd: root,
        stateDirectory: join(root, `.atelier/runtime-${index}`),
        mode: "local",
        timeoutMs: 2_000,
        indexTimeoutMs: 2_000,
        pollIntervalMs: 5,
        environment: { FAKE_RESULT_PATH: providerPath },
      });
      try {
        await assert.rejects(
          provider.search({ workspace: workspace(root), text: "secret", mode: "semantic", limit: 5, includeTests: true, includeGenerated: false }),
          /outside|invalid|repository/i,
          providerPath,
        );
        await assert.rejects(
          provider.read({
            provider: "codesearch",
            opaqueId: Buffer.from(JSON.stringify({ chunkId: "42" }), "utf8").toString("base64url"),
            repositoryId: "repo",
            path: "src/auth.ts",
          }),
          /outside|invalid|repository/i,
          `read ${providerPath}`,
        );
      } finally {
        await provider.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("codesearch index readiness outranks unrelated optional-index errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-optional-status-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_OPTIONAL_STATUS_ERROR: "1" },
  });
  try {
    assert.equal(await provider.ensureIndex(workspace(root)), "ready");
    assert.equal((await provider.status(workspace(root))).indexState, "ready");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch status identifies a competing writer when provider status fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-status-lock-"));
  const fake = fakeCodesearch(root);
  const lockPath = join(root, ".codesearch.db", ".writer.lock");
  mkdirSync(join(root, ".codesearch.db"), { recursive: true });
  writeFileSync(lockPath, "", "utf8");
  const lsof = fakeLsof(root, [
    "p9876",
    "ccodesearch",
    `n${canonicalRoot(lockPath)}`,
    "",
  ].join("\n"));
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    lockCommand: lsof,
    environment: { FAKE_STATUS_ERROR: "1" },
  });
  try {
    const status = await provider.status(workspace(root));
    assert.equal(status.indexState, "failed");
    assert.equal(status.lock?.state, "held");
    assert.deepEqual(status.lock?.holders, [{ pid: 9876, command: "codesearch", paths: [canonicalRoot(lockPath)] }]);
    assert.equal(status.degraded, true);
    assert.match(status.warnings?.join(" ") ?? "", /read fallback.*database lock/i);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch status reports unavailable lock ownership diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-status-lock-unavailable-"));
  const fake = fakeCodesearch(root);
  const lockPath = join(root, ".codesearch.db", ".writer.lock");
  mkdirSync(join(root, ".codesearch.db"), { recursive: true });
  writeFileSync(lockPath, "", "utf8");
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    lockCommand: join(root, "missing-lsof"),
    environment: { FAKE_STATUS_ERROR: "1" },
  });
  try {
    const status = await provider.status(workspace(root));
    assert.equal(status.indexState, "failed");
    assert.equal(status.lock?.state, "unavailable");
    assert.equal(status.degraded, true);
    assert.match(status.warnings?.join(" ") ?? "", /unable to inspect local codesearch database locks/i);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch readiness errors identify a competing database lock holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-readiness-lock-"));
  const fake = fakeCodesearch(root);
  const lockPath = join(root, ".codesearch.db", "fts", ".tantivy-writer.lock");
  mkdirSync(join(root, ".codesearch.db", "fts"), { recursive: true });
  writeFileSync(lockPath, "", "utf8");
  const lsof = fakeLsof(root, ["p9876", "ccodesearch", `n${canonicalRoot(lockPath)}`, ""].join("\n"));
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    lockCommand: lsof,
    environment: { FAKE_STATUS_ERROR: "1" },
  });
  try {
    await assert.rejects(provider.ensureIndex(workspace(root)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /index readiness is blocked.*another process holds the local codesearch database lock.*PID 9876.*close the owning Pi\/Atelier session.*run atlr code index/i);
      assert.doesNotMatch(error.message, /index is missing/i);
      return true;
    });
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch index failures identify a competing database lock holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-index-lock-diagnostic-"));
  const fake = fakeCodesearch(root);
  const lockPath = join(root, ".codesearch.db", "fts", ".tantivy-writer.lock");
  mkdirSync(join(root, ".codesearch.db", "fts"), { recursive: true });
  writeFileSync(lockPath, "", "utf8");
  const lsof = fakeLsof(root, ["p9876", "ccodesearch", `n${canonicalRoot(lockPath)}`, ""].join("\n"));
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    lockCommand: lsof,
    environment: { FAKE_INDEX_LOCKED: "1" },
  });
  try {
    await assert.rejects(
      provider.ensureIndex(workspace(root)),
      /codesearch index(?: --force)? failed[\s\S]*LockBusy[\s\S]*database lock[\s\S]*PID 9876[\s\S]*owning Pi\/Atelier session/i,
    );
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch lock failures retain safe guidance when no holder is observable", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-index-lock-fallback-"));
  const fake = fakeCodesearch(root);
  const lockPath = join(root, ".codesearch.db", ".writer.lock");
  mkdirSync(join(root, ".codesearch.db"), { recursive: true });
  writeFileSync(lockPath, "", "utf8");
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    lockCommand: fakeLsof(root, ""),
    environment: { FAKE_INDEX_LOCKED: "1" },
  });
  try {
    await assert.rejects(provider.ensureIndex(workspace(root)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /LockBusy[\s\S]*concurrent codesearch process may hold[\s\S]*before rerunning atlr code index/i);
      assert.doesNotMatch(error.message, /index is missing|database is missing/i);
      return true;
    });
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch local indexing closes the MCP writer before running the CLI repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-lock-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_MCP_LOCK: "1" },
  });
  try {
    const indexed = await provider.ensureIndex(workspace(root));
    assert.equal(indexed, "ready");
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === canonicalRoot(root)));
    assert.ok(calls.some((args) => args[0] === "stats" && args[1] === canonicalRoot(root)));
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
    stateDirectory: join(root, ".atelier", "runtime"),
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
    assert.ok(processCalls.some((args) => args[0] === "index" && args[1] === "add" && args[2] === canonicalRoot(root)));

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
    stateDirectory: join(root, ".atelier", "runtime"),
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
    stateDirectory: join(root, ".atelier", "runtime"),
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
    stateDirectory: join(root, ".atelier", "runtime"),
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
    assert.ok(calls.some((args) => args[0] === "index" && args[1] === canonicalRoot(root)));
    assert.ok(calls.some((args) => args[0] === "stats" && args[1] === canonicalRoot(root)));
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch does not force a fresh index when MCP startup creates the database", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-fresh-database-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_MCP_CREATES_DB: "1" },
  });
  try {
    assert.equal(await provider.ensureIndex(workspace(root)), "ready");
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const indexCall = calls.find((args) => args[0] === "index" && args[1] === canonicalRoot(root));
    assert.ok(indexCall);
    assert.equal(indexCall.includes("--force"), false);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch repairs an existing empty database without forcing a rebuild", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-empty-database-"));
  mkdirSync(join(root, ".codesearch.db"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_STATS_CHUNKS: "0" },
  });
  try {
    await assert.rejects(provider.ensureIndex(workspace(root)), /vector store contains no indexed chunks/);
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const indexCall = calls.find((args) => args[0] === "index" && args[1] === canonicalRoot(root));
    assert.ok(indexCall);
    assert.equal(indexCall.includes("--force"), false);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch forces an existing index when selection state is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-existing-database-"));
  mkdirSync(join(root, ".codesearch.db"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
  });
  try {
    assert.equal(await provider.ensureIndex(workspace(root)), "ready");
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const indexCall = calls.find((args) => args[0] === "index" && args[1] === canonicalRoot(root));
    assert.ok(indexCall?.includes("--force"));
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch index timeout reports the timeout and preserves partial output", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-index-timeout-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 500,
    pollIntervalMs: 5,
    environment: { FAKE_INDEX_HANG: "1" },
  });
  try {
    await assert.rejects(
      provider.ensureIndex(workspace(root)),
      /codesearch index failed.*timed out after 500 ms[\s\S]*index started but stalled/,
    );
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch forces one local rebuild when repository selection inputs change", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-selection-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "atlr-codesearch-selection-state-"));
  const fake = fakeCodesearch(root);
  writeFileSync(join(root, ".codesearchignore"), "tests/fixtures/codesearch-*/\n", "utf8");

  const run = async () => {
    const provider = new CodesearchProvider({
      command: fake.command,
      cwd: root,
      stateDirectory,
      mode: "local",
      timeoutMs: 2_000,
      indexTimeoutMs: 2_000,
      pollIntervalMs: 5,
    });
    try {
      assert.equal(await provider.ensureIndex(workspace(root)), "ready");
    } finally {
      await provider.close();
    }
  };

  try {
    await run();
    await run();
    writeFileSync(join(root, ".codesearchignore"), "tests/fixtures/codesearch-*/\ndocs/generated/\n", "utf8");
    await run();

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const indexCalls = calls.filter((args) => args[0] === "index" && args[1] === canonicalRoot(root));
    assert.equal(indexCalls.length, 3);
    assert.equal(indexCalls[0]?.includes("--force"), false);
    assert.equal(indexCalls[1]?.includes("--force"), false);
    assert.ok(indexCalls[2]?.includes("--force"));

    const state = JSON.parse(readFileSync(join(stateDirectory, "codesearch-index-state.json"), "utf8")) as {
      version?: number;
      repositories?: Record<string, { fingerprint?: string }>;
    };
    assert.equal(state.version, 1);
    assert.match(state.repositories?.[canonicalRoot(root)]?.fingerprint ?? "", /^[a-f0-9]{64}$/);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch stores mutable selection state outside the repository and migrates legacy state", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-external-state-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "atlr-codesearch-state-home-"));
  const fake = fakeCodesearch(root);
  const run = async () => {
    const provider = new CodesearchProvider({
      command: fake.command,
      cwd: root,
      stateDirectory,
      mode: "local",
      timeoutMs: 2_000,
      indexTimeoutMs: 2_000,
      pollIntervalMs: 5,
    });
    try {
      assert.equal(await provider.ensureIndex(workspace(root)), "ready");
    } finally {
      await provider.close();
    }
  };

  const externalState = join(stateDirectory, "codesearch-index-state.json");
  const legacyState = join(root, ".atelier", "codesearch-index-state.json");
  try {
    await run();
    assert.equal(existsSync(externalState), true);
    assert.equal(existsSync(legacyState), false);
    assert.equal(readdirSync(stateDirectory).some((name) => name.endsWith(".tmp")), false);

    mkdirSync(join(root, ".atelier"), { recursive: true });
    writeFileSync(legacyState, readFileSync(externalState));
    rmSync(externalState);

    await run();
    assert.equal(existsSync(externalState), true, "legacy state was not migrated to runtime storage");
    assert.equal(existsSync(legacyState), false, "legacy repository-local state was not removed");
    assert.equal(readdirSync(join(root, ".atelier")).some((name) => /^codesearch-index-state\.json\..*\.tmp$/.test(name)), false);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch overfetches and reranks implementation searches toward diverse source paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-focus-"));
  const fake = fakeCodesearch(root);
  const rows = [
    { chunk_id: 1, path: "docs/src/features/canonical-retrieval-planning/code-intelligence/index.md", start_line: 1, end_line: 4, score: 0.99 },
    { chunk_id: 2, path: "tests/codesearch-provider.test.ts", start_line: 1, end_line: 4, score: 0.98 },
    { chunk_id: 3, path: "scripts/probe-codesearch-mcp.ts", start_line: 1, end_line: 4, score: 0.97 },
    { chunk_id: 4, path: "packages/core/src/core.ts", start_line: 1, end_line: 4, score: 0.96 },
    { chunk_id: 5, path: "packages/core/src/core.ts", start_line: 8, end_line: 12, score: 0.95 },
    { chunk_id: 6, path: "packages/core/src/code/registry.ts", start_line: 1, end_line: 4, score: 0.94 },
    { chunk_id: 7, path: "README.md", start_line: 1, end_line: 4, score: 0.93 },
    { chunk_id: 8, path: "packages/core/src/code/service.ts", start_line: 1, end_line: 4, score: 0.92 },
  ];
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: { FAKE_SEARCH_ROWS: JSON.stringify(rows) },
  });
  try {
    const hits = await provider.search({
      workspace: workspace(root),
      text: "How does Atelier choose and initialize the configured code intelligence provider?",
      mode: "auto",
      focus: "auto",
      limit: 3,
      includeTests: true,
      includeGenerated: false,
    });
    assert.deepEqual(hits.map((hit) => hit.path), [
      "packages/core/src/core.ts",
      "packages/core/src/code/registry.ts",
      "packages/core/src/code/service.ts",
    ]);
    assert.deepEqual(hits.map((hit) => hit.providerRank), [4, 6, 8]);
    assert.deepEqual(hits.map((hit) => hit.rank), [1, 2, 3]);
    assert.equal(hits[0]?.provenance.reranked, true);
    assert.equal(hits[0]?.provenance.requestedFilters.resolvedFocus, "source");
    assert.ok(hits[0]?.provenance.postProcessing.some((item) => item.includes("source focus")));

    const calls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searchCall = calls.find((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searchCall?.params?.arguments?.limit, 50);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("codesearch fuses bounded literal identifiers into focused automatic retrieval", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-fusion-"));
  const fake = fakeCodesearch(root);
  const semanticRows = [
    { chunk_id: 1, path: "docs/src/features/canonical-retrieval-planning/code-intelligence/index.md", start_line: 1, end_line: 4, score: 0.99 },
    { chunk_id: 2, path: "packages/core/src/core.ts", start_line: 1, end_line: 4, score: 0.95 },
    { chunk_id: 3, path: "README.md", start_line: 1, end_line: 4, score: 0.90 },
  ];
  const literalRows = [
    { chunk_id: 4, path: "packages/core/src/code/registry.ts", start_line: 1, end_line: 4, score: 1.0 },
    { chunk_id: 5, path: "packages/core/src/code/service.ts", start_line: 1, end_line: 4, score: 0.9 },
    { chunk_id: 2, path: "packages/core/src/core.ts", start_line: 1, end_line: 4, score: 0.8 },
  ];
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: {
      FAKE_SEMANTIC_ROWS: JSON.stringify(semanticRows),
      FAKE_LITERAL_ROWS: JSON.stringify(literalRows),
    },
  });
  try {
    const hits = await provider.search({
      workspace: workspace(root),
      text: "How does Atelier choose and initialize the configured code intelligence provider?",
      mode: "auto",
      focus: "source",
      literalHints: ["createCodeProvider", "CodeProviderRegistry", "codeProvider"],
      limit: 3,
      includeTests: true,
      includeGenerated: false,
    });
    assert.deepEqual(hits.map((hit) => hit.path), [
      "packages/core/src/core.ts",
      "packages/core/src/code/registry.ts",
      "packages/core/src/code/service.ts",
    ]);
    assert.deepEqual(hits[0]?.retrievalMethods.sort(), ["lexical", "semantic"]);
    assert.equal(hits[0]?.provenance.actualMode, "hybrid");
    assert.equal(hits[0]?.provenance.degraded, undefined);
    assert.ok(hits[0]?.provenance.postProcessing.some((item) => item.includes("literal identifier augmentation")));

    const calls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searches = calls.filter((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searches[0]?.params?.arguments?.mode, "semantic");
    assert.ok(searches.slice(1).some((call) => call.params?.arguments?.mode === "literal"));
    assert.ok(searches.slice(1).every((call) => call.params?.arguments?.limit === 50), "exact-hint augmentation must retain the bounded focused candidate pool for accepted source recall");
    assert.ok(searches.length <= 5);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch augmentation uses explicit identifier hints instead of generic workflow nouns", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-hints-"));
  const fake = fakeCodesearch(root);
  const semanticRows = [
    { chunk_id: 1, path: "src/registry.ts", start_line: 1, end_line: 4, score: 0.9 },
    { chunk_id: 2, path: "src/service.ts", start_line: 1, end_line: 4, score: 0.8 },
  ];
  const literalRows = [
    { chunk_id: 1, path: "src/registry.ts", start_line: 1, end_line: 4, score: 3.0 },
  ];
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
    environment: {
      FAKE_SEMANTIC_ROWS: JSON.stringify(semanticRows),
      FAKE_LITERAL_ROWS: JSON.stringify(literalRows),
    },
  });
  try {
    const hits = await provider.search({
      workspace: workspace(root),
      text: "where is code provider selection implemented",
      mode: "auto",
      focus: "source",
      literalHints: ["CodeProviderRegistry"],
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    assert.deepEqual(hits[0]?.retrievalMethods.sort(), ["lexical", "semantic"]);
    assert.deepEqual(hits[0]?.provenance.requestedFilters.literalHints, ["CodeProviderRegistry"]);

    const calls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searches = calls.filter((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searches.length, 2);
    assert.equal(searches[0]?.params?.arguments?.mode, "semantic");
    assert.equal(searches[1]?.params?.arguments?.mode, "literal");
    assert.equal(searches[1]?.params?.arguments?.query, "CodeProviderRegistry");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("codesearch does not augment healthy semantic search with generic natural-language terms", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-codesearch-no-generic-"));
  const fake = fakeCodesearch(root);
  const provider = new CodesearchProvider({
    command: fake.command,
    cwd: root,
    stateDirectory: join(root, ".atelier", "runtime"),
    mode: "local",
    timeoutMs: 2_000,
    indexTimeoutMs: 2_000,
    pollIntervalMs: 5,
  });
  try {
    await provider.search({
      workspace: workspace(root),
      text: "where is provider selection implemented",
      mode: "auto",
      focus: "source",
      limit: 5,
      includeTests: true,
      includeGenerated: false,
    });
    const calls = readFileSync(fake.mcpLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } });
    const searches = calls.filter((call) => call.method === "tools/call" && call.params?.name === "search");
    assert.equal(searches.length, 1);
    assert.equal(searches[0]?.params?.arguments?.mode, "semantic");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
