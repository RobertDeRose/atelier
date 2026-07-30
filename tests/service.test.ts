import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { AtelierCore, AtelierServiceClient, AtelierServiceServer, DisabledCodeProvider } from "../packages/core/src/index.ts";
import { createTemporaryRepository } from "./fixtures.ts";

test("local Core service serializes shared status and state requests", async () => {
  const root = createTemporaryRepository("atlr-service-");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  const socketPath = join(root, ".runtime", "atelier.sock");
  const server = new AtelierServiceServer({ core, socketPath });
  await server.start();
  try {
    const client = new AtelierServiceClient(socketPath);
    const ping = await client.request<any>("ping");
    assert.equal(ping.repositoryRoot, core.config.repositoryRoot);
    const status = await client.request<any>("status");
    assert.equal(status.workspace.root, core.config.workspaceRoot);
    const state = await client.request<any>("state");
    assert.equal(state.snapshot.repositoryId, core.repository.snapshot().repositoryId);
    await assert.rejects(client.request("unknown"), /Unknown Atelier service method/);
  } finally {
    await server.stop();
    await core.close();
  }
});
