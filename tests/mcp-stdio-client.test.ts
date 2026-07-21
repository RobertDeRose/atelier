import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStdioClient } from "../packages/core/src/index.ts";

test("MCP stdio client exchanges bounded JSON-RPC messages without shell interpolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-mcp-"));
  const script = join(root, "provider.mjs");
  writeFileSync(script, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } }) + '\\n');
});
`, "utf8");
  const client = new McpStdioClient(process.execPath, [script], { cwd: root, timeoutMs: 2000 });
  try {
    const result = await client.request<{ method: string; params: { value: string } }>("tools/call", { value: "$(touch should-not-run)" });
    assert.equal(result.method, "tools/call");
    assert.equal(result.params.value, "$(touch should-not-run)");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
