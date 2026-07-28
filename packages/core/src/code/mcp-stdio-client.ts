import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { newId } from "../util/ids.ts";
import { ATELIER_VERSION } from "../version.ts";

interface JsonRpcSuccess<T> { jsonrpc: "2.0"; id: string | number; result: T }
interface JsonRpcFailure { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string; data?: unknown } }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version?: string };
  instructions?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string | number, PendingRequest>();
  private stderr = "";
  private initialized: McpInitializeResult | undefined;
  private readonly command: string;
  private readonly args: string[];
  private readonly options: { cwd: string; timeoutMs?: number; environment?: Record<string, string> };

  constructor(command: string, args: string[], options: { cwd: string; timeoutMs?: number; environment?: Record<string, string> }) {
    this.command = command;
    this.args = args;
    this.options = options;
  }

  start(): void {
    if (this.child !== undefined) return;
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`MCP provider exited (${signal ?? code ?? "unknown"}): ${this.stderr.trim()}`));
      this.child = undefined;
      this.initialized = undefined;
    });
  }

  async initialize(options: { clientName?: string; clientVersion?: string; protocolVersion?: string } = {}): Promise<McpInitializeResult> {
    if (this.initialized !== undefined) return this.initialized;
    const result = await this.request<McpInitializeResult>("initialize", {
      protocolVersion: options.protocolVersion ?? "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? "atelier",
        version: options.clientVersion ?? ATELIER_VERSION,
      },
    });
    if (!result || typeof result.protocolVersion !== "string" || !result.serverInfo || typeof result.serverInfo.name !== "string") {
      throw new Error("MCP provider returned an invalid initialize response.");
    }
    this.initialized = result;
    this.notify("notifications/initialized");
    return result;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.initialize();
    const result = await this.request<{ tools?: McpToolDefinition[] }>("tools/list");
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.initialize();
    const result = await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
    if (result.isError === true) {
      const text = result.content?.map((item) => item.text).filter(Boolean).join("\n") || `MCP tool ${name} failed.`;
      throw new Error(text);
    }
    return result;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.start();
    const child = this.child;
    if (child === undefined) throw new Error("MCP provider did not start.");
    const id = newId("rpc");
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.start();
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.initialized = undefined;

    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const exited = await waitForChildExit(child, 2_000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }

  stderrTail(): string {
    return this.stderr;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcSuccess<unknown> | JsonRpcFailure;
    try {
      message = JSON.parse(line) as JsonRpcSuccess<unknown> | JsonRpcFailure;
    } catch {
      return;
    }
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if ("error" in message) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(value);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
