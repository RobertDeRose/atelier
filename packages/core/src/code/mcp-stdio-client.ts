import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { newId } from "../util/ids.ts";
import { ATELIER_VERSION } from "../version.ts";
import { minimalEnvironment } from "../process/environment.ts";

export const MAX_MCP_LINE_BYTES = 1_048_576;
export const MAX_MCP_PAYLOAD_BYTES = 524_288;

interface JsonRpcSuccess<T> { jsonrpc: "2.0"; id: string | number; result: T }
interface JsonRpcFailure { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string; data?: unknown } }
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}
interface McpRequestOptions { signal?: AbortSignal | undefined }
interface McpCloseOptions { signal?: AbortSignal | undefined }

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
  private stdoutBuffer = "";
  private readonly pending = new Map<string | number, PendingRequest>();
  private stderr = "";
  private initialized: McpInitializeResult | undefined;
  private closing: Promise<void> | undefined;
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
    if (this.closing !== undefined) throw new Error("MCP provider is closing.");
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: minimalEnvironment({ overrides: this.options.environment }),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
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

  async initialize(options: { clientName?: string; clientVersion?: string; protocolVersion?: string; signal?: AbortSignal | undefined } = {}): Promise<McpInitializeResult> {
    if (this.initialized !== undefined) return this.initialized;
    const result = await this.request<McpInitializeResult>("initialize", {
      protocolVersion: options.protocolVersion ?? "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? "atelier",
        version: options.clientVersion ?? ATELIER_VERSION,
      },
    }, { signal: options.signal });
    if (!result || typeof result.protocolVersion !== "string" || !result.serverInfo || typeof result.serverInfo.name !== "string") {
      throw new Error("MCP provider returned an invalid initialize response.");
    }
    this.initialized = result;
    this.notify("notifications/initialized");
    return result;
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpToolDefinition[]> {
    await this.initialize(options);
    const result = await this.request<{ tools?: McpToolDefinition[] }>("tools/list", undefined, options);
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions = {}): Promise<McpToolCallResult> {
    await this.initialize(options);
    const result = await this.request<McpToolCallResult>("tools/call", { name, arguments: args }, options);
    if (result.isError === true) {
      const text = result.content?.map((item) => item.text).filter(Boolean).join("\n") || `MCP tool ${name} failed.`;
      throw new Error(text);
    }
    return result;
  }

  async request<T>(method: string, params?: unknown, options: McpRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw new Error(`MCP request cancelled: ${method}`);
    this.start();
    const child = this.child;
    if (child === undefined) throw new Error("MCP provider did not start.");
    const id = newId("rpc");
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    let encoded: string;
    try {
      encoded = this.encodeMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failProvider(failure);
      throw failure;
    }
    let timeout: NodeJS.Timeout;
    let onAbort: (() => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.failProvider(new Error(`MCP request timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      onAbort = () => {
        const error = new Error(`MCP request cancelled: ${method}`);
        this.failAll(error);
        void this.close({ signal: options.signal });
      };
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout, signal: options.signal, onAbort });
    });
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort!, { once: true });
      if (options.signal.aborted) onAbort!();
    }
    try {
      child.stdin.write(`${encoded}\n`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failProvider(failure);
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.start();
    try {
      this.child?.stdin.write(`${this.encodeMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
    } catch (error) {
      this.failProvider(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async close(options: McpCloseOptions = {}): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const child = this.child;
    this.child = undefined;
    this.initialized = undefined;
    this.failAll(new Error("MCP provider closed."));
    if (child === undefined) return;

    const operation = (async () => {
      const forceKill = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* exited */ }
        }
      };
      const onAbort = (): void => forceKill();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (options.signal?.aborted) forceKill();
        const exited = await waitForChildExit(child, options.signal?.aborted ? 100 : 2_000);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          forceKill();
          await waitForChildExit(child, 1_000);
        }
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    })();
    this.closing = operation;
    try {
      await operation;
    } finally {
      if (this.closing === operation) this.closing = undefined;
    }
  }

  processId(): number | undefined {
    return this.child?.pid;
  }

  stderrTail(): string {
    return this.stderr;
  }

  private onStdoutData(chunk: Buffer): void {
    let text = chunk.toString("utf8");
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      const fragment = newline < 0 ? text : text.slice(0, newline);
      if (Buffer.byteLength(this.stdoutBuffer) + Buffer.byteLength(fragment) > MAX_MCP_LINE_BYTES) {
        this.failProvider(new Error(`MCP response line exceeded maximum size of ${MAX_MCP_LINE_BYTES} bytes.`));
        this.stdoutBuffer = "";
        return;
      }
      this.stdoutBuffer += fragment;
      if (newline < 0) return;
      const line = this.stdoutBuffer.endsWith("\r") ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.onLine(line);
      text = text.slice(newline + 1);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > MAX_MCP_PAYLOAD_BYTES) {
      this.failProvider(new Error(`MCP JSON payload exceeded maximum size of ${MAX_MCP_PAYLOAD_BYTES} bytes.`));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || !("id" in parsed)) return;
    const message = parsed as JsonRpcSuccess<unknown> | JsonRpcFailure;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.clearPending(message.id, pending);
    if ("error" in message) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failProvider(error: Error): void {
    this.failAll(error);
    const termination = new AbortController();
    termination.abort(error);
    void this.close({ signal: termination.signal });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending);
      pending.reject(error);
    }
  }

  private encodeMessage(message: Record<string, unknown>): string {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > MAX_MCP_PAYLOAD_BYTES) {
      throw new Error(`MCP JSON payload exceeded maximum size of ${MAX_MCP_PAYLOAD_BYTES} bytes.`);
    }
    return encoded;
  }

  private clearPending(id: string | number, pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(id);
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
