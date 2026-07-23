import { McpStdioClient, type McpToolDefinition } from "../packages/core/src/code/mcp-stdio-client.ts";

const root = process.argv[2] ?? process.cwd();
const client = new McpStdioClient("octocode", ["mcp", "--path", root], { cwd: root, timeoutMs: 120_000 });

function has(tools: McpToolDefinition[], name: string): boolean { return tools.some((tool) => tool.name === name); }

try {
  const initialize = await client.initialize({ clientVersion: "0.9.2" });
  const tools = await client.listTools();
  const calls: Record<string, unknown> = {};
  if (has(tools, "semantic_search")) {
    calls.semantic_search = await client.callTool("semantic_search", {
      query: ["code provider selection", "provider registry"],
      mode: "code",
      detail_level: "partial",
      max_results: 10,
    });
  }
  if (has(tools, "view_signatures")) {
    calls.view_signatures = await client.callTool("view_signatures", {
      files: ["packages/core/src/code/octocode-provider.ts", "packages/core/src/core.ts"],
    });
  }
  if (has(tools, "structural_search")) {
    calls.structural_search = await client.callTool("structural_search", {
      pattern: "new $PROVIDER($$$ARGS)",
      language: "typescript",
      paths: ["packages/core/src/**/*.ts"],
      context: 2,
      max_results: 20,
    });
  }
  calls.graphrag = has(tools, "graphrag")
    ? await client.callTool("graphrag", { action: "get-relationships", node_id: "packages/core/src/core.ts", limit: 20, depth: 1 })
    : { skipped: true, reason: "graphrag was not advertised by this Octocode installation" };
  process.stdout.write(`${JSON.stringify({ initialize, tools, calls }, null, 2)}\n`);
} finally {
  await client.close();
}
