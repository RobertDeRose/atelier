import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OctocodeProvider, type CodeWorkspace } from "../packages/core/src/index.ts";

const TEST_TOOL_TIMEOUT_MS = 10_000;

function workspace(root: string): CodeWorkspace {
  return {
    id: "work",
    name: "work",
    roots: [root],
    repositories: [{
      id: "repo",
      name: "repo",
      root,
      snapshot: { repositoryId: "repo", workspaceId: "work", vcs: "git", headCommit: "head", dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1 },
    }],
  };
}

function textOctocode(root: string): { command: string; log: string } {
  const command = join(root, "octocode-text");
  const log = join(root, "calls.jsonl");
  writeFileSync(command, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') { console.log('octocode 0.14.0'); process.exit(0); }
if (args[0] === 'stats') { console.log('Code blocks: 20\\nText blocks: 0\\nDocument blocks: 0\\nCommit blocks: 0\\nCode model: fastembed:jinaai/jina-embeddings-v2-base-code\\nText model: fastembed:nomic-ai/nomic-embed-text-v1.5'); process.exit(0); }
if (args[0] === 'index') process.exit(0);
if (args[0] !== 'mcp') process.exit(2);
let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(!line.trim()) continue; const request=JSON.parse(line); if(!('id' in request)) continue; let result={};
if(request.method==='initialize') result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'octocode-mcp',version:'0.14.0'}};
else if(request.method==='tools/list') result={tools:[
{name:'semantic_search',inputSchema:{type:'object',properties:{query:{description:'String or array of strings. Array preferred.'},max_results:{type:'integer',maximum:20},mode:{type:'string'},detail_level:{type:'string'},threshold:{type:'number'}}}},
{name:'view_signatures',inputSchema:{type:'object',properties:{files:{type:'array'}}}},
{name:'graphrag',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['search','get-node','get-relationships','find-path','overview']},node_id:{type:'string'},max_depth:{type:'integer'},format:{type:'string'}}}}
]};
else if(request.method==='tools/call') { const {name,arguments:input}=request.params; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool:name,input })+'\\n'); if(name==='semantic_search') { const query=Array.isArray(input.query)?input.query.join(' '):String(input.query); const exact=query.includes('OctocodeProvider'); result={content:[{type:'text',text:exact?'CODE RESULTS (1)\\n1. packages/core/src/code/octocode-provider.ts\\n | Similarity 0.912\\n41: export class OctocodeProvider implements CodeProvider {\\n42:   readonly name = "octocode";\\n':'CODE RESULTS (1)\\n1. packages/core/src/core.ts\\n | Similarity 0.660\\n324: function createCodeProviders(config: AtelierConfig) {\\n325:   if (config.codeProvider === "octocode") return new OctocodeProvider();\\n'}],isError:false}; }
else if(name==='graphrag') result={content:[{type:'text',text:'RELATIONSHIPS\\n- imports -> packages/core/src/code/octocode-provider.ts: provider construction'}],isError:false}; else result={content:[{type:'text',text:'SIGNATURES (1 files)\\n\\nFILE: packages/core/src/code/octocode-provider.ts\\nLanguage: typescript\\n41: export class OctocodeProvider implements CodeProvider {'}],isError:false}; }
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n'); }});`, "utf8");
  chmodSync(command, 0o755);
  return { command, log };
}

test("Octocode adapter normalizes real text MCP search, symbol, and GraphRAG responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-octocode-text-"));
  mkdirSync(join(root, "packages/core/src/code"), { recursive: true });
  writeFileSync(join(root, "packages/core/src/core.ts"), "export function createCodeProviders() {}\n", "utf8");
  writeFileSync(join(root, "packages/core/src/code/octocode-provider.ts"), "\n".repeat(40) + "export class OctocodeProvider implements CodeProvider {}\n", "utf8");
  const fake = textOctocode(root);
  const provider = new OctocodeProvider({ command: fake.command, cwd: root, timeoutMs: TEST_TOOL_TIMEOUT_MS });
  const work = workspace(root);
  try {
    const search = await provider.search({ workspace: work, text: "Where is code provider selection implemented?", mode: "semantic", focus: "source", limit: 10, includeTests: true, includeGenerated: false });
    assert.equal(search.length, 1);
    assert.equal(search[0]?.path, "packages/core/src/core.ts");
    assert.equal(search[0]?.startLine, 324);
    assert.equal(search[0]?.providerScore, 0.66);

    const symbols = await provider.symbols({ workspace: work, text: "OctocodeProvider", limit: 10 });
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0]?.path, "packages/core/src/code/octocode-provider.ts");
    assert.match(symbols[0]?.preview ?? "", /class OctocodeProvider/);

    const relationships = await provider.relationships({ workspace: work, reference: search[0]!.reference, kinds: ["imports"], depth: 1, limit: 10 });
    assert.equal(relationships.length, 1);
    assert.equal(relationships[0]?.kind, "imports");
    assert.equal(relationships[0]?.target.path, "packages/core/src/code/octocode-provider.ts");

    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { tool?: string; input?: Record<string, unknown> });
    const symbolCall = calls.find((call) => call.tool === "semantic_search" && call.input?.detail_level === "signatures");
    assert.equal(symbolCall?.input?.threshold, 0);
    const graphCall = calls.find((call) => call.tool === "graphrag");
    assert.equal(graphCall?.input?.operation, "get-relationships");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
