import assert from "node:assert/strict";
import test from "node:test";
import { codeSearchMarkdown, codeSymbolsMarkdown } from "../apps/pi-extension/src/code-tool-presentation.ts";
import { codeStatusMarkdown, statusMarkdown } from "../apps/pi-extension/src/command-reports.ts";

function retrieval(): any {
  return {
    sessionId: "retrieval-1",
    lastDecision: { kind: "provider_call", reason: "explicit lookup" },
    inventory: {
      freshness: "current",
      evidenceCount: 2,
      uniquePathCount: 2,
      knownPaths: [],
      resolvedSymbols: ["AtelierCore"],
      unresolvedSymbols: [],
    },
    budget: {
      providerRequestsLimit: 8,
      providerRequestsUsed: 2,
      uniquePathsLimit: 32,
      uniquePathsUsed: 2,
    },
    telemetry: {
      bytesReturned: 128,
      truncated: false,
      duplicateResultsRemoved: 0,
      duplicatePathsRemoved: 0,
      duplicateReferencesRemoved: 0,
    },
  };
}

test("status report uses concise bold field-value Markdown", () => {
  const report = statusMarkdown({
    repositoryRoot: "/workspace",
    workspaceRoot: "/workspace",
    workspaceSource: "startup_cwd",
    mode: "investigate",
    workflowCheckpoint: "none",
    closureStatus: "not applicable — no active task",
    planStatus: "missing",
    taskProvider: { provider: "none", available: true, initialized: false },
    repositoryProvider: "git",
    workspaceId: "workspace-1",
    snapshot: { repositoryId: "git:1", workspaceId: "workspace-1", vcs: "git", headCommit: "deadbeef", dirtyGeneration: 0, dirtyFingerprint: "clean", indexSchemaVersion: 1 },
    currentTaskId: undefined,
    nextAction: "Start planning.",
    activeExecutionGrant: undefined,
    closureReadiness: { ready: false, validationReady: false, finalDiffReviewed: false, localChangeCreated: false, repositoryStateAcceptable: true, reason: "No active task.", blockers: [] },
    planObjective: undefined,
    approvedPlanHash: undefined,
    currentPlanHash: undefined,
  } as any);
  assert.match(report, /^\*\*workspace:\*\* `\/workspace`/m);
  assert.match(report, /^\*\*mode:\*\* `investigate`/m);
  assert.doesNotMatch(report, /^\| field \| value \|/m);
  assert.match(report, /^### Next action/m);
});

test("disabled code intelligence is neutral and explicit", () => {
  const report = codeStatusMarkdown({
    identity: { name: "disabled", version: "none" },
    available: false,
    healthy: false,
    indexState: "unknown",
    capabilities: [],
    detail: "Code intelligence is disabled or no provider is configured.",
  } as any, retrieval());
  assert.match(report, /^\*\*state:\*\* disabled/m);
  assert.doesNotMatch(report, /offline/);
});

test("code reports separate definitions from references and group semantic results", () => {
  const hits = [
    { rank: 1, repositoryName: "repo", repositoryId: "repo", path: "packages/core/src/core.ts", startLine: 193, symbol: "class AtelierCore", preview: "class AtelierCore", provider: "codesearch", evidenceId: "one", revision: "r1" },
    { rank: 2, repositoryName: "repo", repositoryId: "repo", path: "apps/pi-extension/src/index.ts", startLine: 133, symbol: "function replaceCore(...): AtelierCore", preview: "function replaceCore", provider: "codesearch", evidenceId: "two", revision: "r1" },
    { rank: 3, repositoryName: "repo", repositoryId: "repo", path: "tests/core.test.ts", startLine: 20, symbol: "test helper", preview: "test helper", provider: "codesearch", evidenceId: "three", revision: "r1" },
  ] as any;
  const symbols = codeSymbolsMarkdown("AtelierCore", hits, retrieval());
  assert.match(symbols, /^### Definitions/m);
  assert.match(symbols, /^### References/m);
  assert.ok(symbols.indexOf("packages/core/src/core.ts") < symbols.indexOf("apps/pi-extension/src/index.ts"));

  const search = codeSearchMarkdown("Atelier Core", hits, retrieval());
  assert.match(search, /^### Definitions/m);
  assert.match(search, /^### Tests/m);
  assert.match(search, /^### Retrieval/m);
});
