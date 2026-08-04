import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStdioClient } from "../packages/core/src/index.ts";

async function readProcessPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`provider pid file was not created: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} remained alive`);
}

test("MCP request timeout terminates the provider process", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-mcp-timeout-"));
  const script = join(root, "provider.mjs");
  const pidPath = join(root, "provider.pid");
  writeFileSync(script, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume();
`, "utf8");
  const client = new McpStdioClient(process.execPath, [script], { cwd: root, timeoutMs: 500 });
  try {
    client.start();
    const pid = await readProcessPid(pidPath);
    await assert.rejects(client.request("hung", {}), /timed out/i);
    await waitForProcessExit(pid);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP request cancellation terminates the provider process", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-mcp-cancel-"));
  const script = join(root, "provider.mjs");
  const pidPath = join(root, "provider.pid");
  writeFileSync(script, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume();
`, "utf8");
  const client = new McpStdioClient(process.execPath, [script], { cwd: root, timeoutMs: 2_000 });
  const controller = new AbortController();
  try {
    const request = client.request("hung", {}, { signal: controller.signal });
    const pid = await readProcessPid(pidPath);
    controller.abort();
    await assert.rejects(request, /cancel/i);
    await waitForProcessExit(pid);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
