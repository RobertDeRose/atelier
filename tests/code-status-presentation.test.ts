import assert from "node:assert/strict";
import test from "node:test";
import { codeStatusMarkdown, codeStatusSummary } from "../apps/pi-extension/src/command-reports.ts";
import type { CodeProviderStatus, RetrievalSessionStatus } from "../packages/core/src/index.ts";

const retrieval = {
  inventory: { freshness: "unknown", evidenceCount: 0, uniquePathCount: 0 },
  budget: { providerRequestsLimit: 8, providerRequestsUsed: 0 },
} as unknown as RetrievalSessionStatus;

test("/code-status presents actionable codesearch lock diagnostics", () => {
  const status: CodeProviderStatus = {
    identity: { name: "codesearch", instanceId: "codesearch:auto" },
    available: true,
    healthy: true,
    capabilities: [],
    indexState: "failed",
    degraded: true,
    warnings: ["codesearch database lock detected; another process may be using the local index"],
    lock: {
      state: "held",
      databasePaths: ["/workspace/.codesearch.db"],
      holders: [{ pid: 9876, command: "codesearch", paths: ["/workspace/.codesearch.db/fts/.tantivy-writer.lock"] }],
    },
  };
  const markdown = codeStatusMarkdown(status, retrieval);

  assert.match(codeStatusSummary(status, retrieval), /lock held/);
  assert.match(markdown, /### Database lock/);
  assert.match(markdown, /PID 9876/);
  assert.match(markdown, /codesearch\.db/);
  assert.match(markdown, /codesearch/);
  assert.match(markdown, /another process may be using the local index/);
});
