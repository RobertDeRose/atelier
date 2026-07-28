import { McpStdioClient, type McpToolDefinition } from "../packages/core/src/code/mcp-stdio-client.ts";
import { ATELIER_VERSION } from "../packages/core/src/version.ts";

const root = process.argv[2] ?? process.cwd();
const client = new McpStdioClient("octocode", ["mcp", "--path", root], { cwd: root, timeoutMs: 120_000 });

function has(tools: McpToolDefinition[], name: string): boolean { return tools.some((tool) => tool.name === name); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const calls: Record<string, unknown> = {};
async function capture(name: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    calls[name] = await operation();
  } catch (error) {
    calls[name] = { error: message(error) };
  }
}

try {
  const initialize = await client.initialize({ clientVersion: ATELIER_VERSION });
  const tools = await client.listTools();
  if (has(tools, "semantic_search")) {
    await capture("semantic_search", () => client.callTool("semantic_search", {
      query: ["code provider selection", "provider registry"],
      mode: "code",
      detail_level: "partial",
      max_results: 20,
    }));
  }
  if (has(tools, "view_signatures")) {
    await capture("view_signatures", () => client.callTool("view_signatures", {
      files: ["packages/core/src/code/octocode-provider.ts", "packages/core/src/core.ts"],
    }));
  }
  if (has(tools, "structural_search")) {
    await capture("structural_search", () => client.callTool("structural_search", {
      pattern: "new $PROVIDER($$$ARGS)",
      language: "typescript",
      paths: ["packages/core/src/**/*.ts"],
      context: 2,
      max_results: 20,
    }));
  }
  calls.graphrag = has(tools, "graphrag")
    ? await client.callTool("graphrag", { operation: "get-relationships", node_id: "packages/core/src/core.ts", max_depth: 1, format: "json" }).catch((error) => ({ error: message(error) }))
    : { skipped: true, reason: "graphrag was not advertised by this Octocode installation" };
  process.stdout.write(`${JSON.stringify({ initialize, tools, calls }, null, 2)}\n`);
} finally {
  await client.close();
}
