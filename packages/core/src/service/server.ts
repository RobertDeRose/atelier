import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type { AtelierCore } from "../core.ts";
import { createStatusView } from "../presentation/status-view.ts";
import { redactValue } from "../security/redaction.ts";
import type { ServiceRequest, ServiceResponse } from "./protocol.ts";

export interface AtelierServiceOptions {
  core: AtelierCore;
  socketPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AtelierServiceServer {
  readonly socketPath: string;
  private readonly core: AtelierCore;
  private server: Server | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(options: AtelierServiceOptions) {
    this.core = options.core;
    this.socketPath = resolve(options.socketPath);
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolveStart();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    }
    await this.queue.catch(() => {});
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        this.queue = this.queue.then(async () => {
          let response: ServiceResponse;
          try {
            const request = JSON.parse(line) as ServiceRequest;
            response = { id: request.id, ok: true, result: redactValue(await this.handle(request)) };
          } catch (error) {
            response = { id: "unknown", ok: false, error: { message: errorMessage(error) } };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        });
      }
    });
  }

  private async handle(request: ServiceRequest): Promise<unknown> {
    switch (request.method) {
      case "ping": return { version: 1, repositoryRoot: this.core.config.repositoryRoot };
      case "status": return createStatusView(await this.core.status());
      case "state": return await this.core.buildWorkingState();
      case "workspace": return this.core.codeWorkspace();
      case "code.status": return await this.core.code.status();
      case "code.search": {
        const query = typeof request.params?.query === "string" ? request.params.query : "";
        if (!query) throw new Error("code.search requires params.query");
        return await this.core.code.search({ workspace: this.core.codeWorkspace(), text: query, mode: "semantic", limit: 10 });
      }
      case "shutdown": {
        setImmediate(() => { void this.stop(); });
        return { stopping: true };
      }
      default: throw new Error(`Unknown Atelier service method: ${request.method}`);
    }
  }
}
