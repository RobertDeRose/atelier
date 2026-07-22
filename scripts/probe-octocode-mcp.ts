import { McpStdioClient } from "../packages/core/src/code/mcp-stdio-client.ts";
const root = process.argv[2] ?? process.cwd();
const client = new McpStdioClient("octocode", ["mcp", "--path", root], { cwd: root, timeoutMs: 60_000 });
try {
  const initialize = await client.initialize({ clientVersion: "0.9.0" });
  const tools = await client.listTools();
  process.stdout.write(`${JSON.stringify({ initialize, tools }, null, 2)}\n`);
} finally {
  await client.close();
}
