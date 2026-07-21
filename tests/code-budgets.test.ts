import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeService } from "../packages/core/src/code/service.ts";
import { CodeProviderRegistry } from "../packages/core/src/code/registry.ts";
import { MockCodeProvider } from "../packages/core/src/code/mock-provider.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";

const snapshot = { repositoryId: "repo", workspaceId: "ws", vcs: "none" as const, headCommit: "x", dirtyGeneration: 0, dirtyFingerprint: "x", indexSchemaVersion: 1 };
const workspace = { id: "ws", name: "ws", roots: ["/tmp/repo"], repositories: [{ id: "repo", name: "repo", root: "/tmp/repo", snapshot }] };

test("enforces provider-neutral result and preview budgets", async () => {
  const provider = new MockCodeProvider([{ repositoryId: "repo", repositoryName: "repo", root: "/tmp/repo", path: "a.ts", content: "test " + "x".repeat(100), symbol: "A" }, { repositoryId: "repo", repositoryName: "repo", root: "/tmp/repo", path: "b.ts", content: "test " + "y".repeat(100), symbol: "B" }]);
  const ledger = new SqliteLedger(join(mkdtempSync(join(tmpdir(), "atlr-budget-")), "state.db"));
  const service = new CodeService(new CodeProviderRegistry([provider], provider.name), ledger, { maxResults: 1, maxPreviewBytes: 20, maxChunkBytes: 20, maxFetches: 1, maxTotalBytes: 20 });
  const results = await service.search({ workspace, text: "test", limit: 10 });
  assert.equal(results.length, 1); assert.match(results[0]?.preview ?? "", /truncated/);
  ledger.close();
});
