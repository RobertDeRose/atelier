import { createConnection } from "node:net";
import { newId } from "../util/ids.ts";
import type { ServiceRequest, ServiceResponse } from "./protocol.ts";

export class AtelierServiceClient {
  readonly socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const request: ServiceRequest = { id: newId("rpc"), method, ...(params === undefined ? {} : { params }) };
    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        socket.end();
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as ServiceResponse;
          if (!response.ok) reject(new Error(response.error.message));
          else resolve(response.result as T);
        } catch (error) { reject(error); }
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    });
  }
}
