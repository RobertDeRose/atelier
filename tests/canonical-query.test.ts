import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeEvidenceIdentities,
  canonicalizeEvidenceIdentity,
  canonicalizeRetrievalQuery,
  decideCanonicalQueryReuse,
  DisabledCodeProvider,
  MockCodeProvider,
  type CanonicalQueryInput,
  type RepositorySnapshot,
} from "../packages/core/src/index.ts";

const gitSnapshot: RepositorySnapshot = {
  repositoryId: "git-repo",
  workspaceId: "workspace",
  vcs: "git",
  headCommit: "git-head",
  dirtyGeneration: 2,
  dirtyFingerprint: "git-dirty",
  indexSchemaVersion: 1,
};

const jjSnapshot: RepositorySnapshot = {
  repositoryId: "jj-repo",
  workspaceId: "workspace",
  vcs: "jj",
  headCommit: "jj-commit",
  changeId: "jj-change",
  operationId: "jj-operation",
  dirtyGeneration: 3,
  dirtyFingerprint: "jj-dirty",
  indexSchemaVersion: 1,
};

function input(overrides: Partial<CanonicalQueryInput> = {}): CanonicalQueryInput {
  return {
    operation: "search",
    text: "Trace CodeService retrieval",
    provider: { name: "codesearch", version: "1.1.30", instanceId: "local" },
    workspaceId: "workspace",
    repositories: [
      { repositoryId: "jj-repo", snapshot: jjSnapshot },
      { repositoryId: "git-repo", snapshot: gitSnapshot },
    ],
    indexRevision: "index-a",
    mode: "semantic",
    focus: "source",
    filters: {
      repositoryIds: ["jj-repo", "git-repo"],
      languages: ["typescript", "javascript"],
      pathGlobs: ["packages/**", "apps/**"],
      literalHints: ["RepositoryStatePlanner", "CodeService"],
      relationshipKinds: ["references", "imports"],
      includeTests: true,
      includeGenerated: false,
      depth: 1,
    },
    requestedLimit: 10,
    ...overrides,
  };
}

test("canonical query digest is deterministic across set and repository ordering", () => {
  const first = canonicalizeRetrievalQuery(input());
  const second = canonicalizeRetrievalQuery(input({
    repositories: [
      { repositoryId: "git-repo", snapshot: { ...gitSnapshot } },
      { repositoryId: "jj-repo", snapshot: { ...jjSnapshot } },
    ],
    filters: {
      repositoryIds: ["git-repo", "jj-repo"],
      languages: ["javascript", "typescript"],
      pathGlobs: ["apps/**", "packages/**"],
      literalHints: ["CodeService", "RepositoryStatePlanner"],
      relationshipKinds: ["imports", "references"],
      includeGenerated: false,
      includeTests: true,
      depth: 1,
    },
  }));

  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.binding.repositories.map((item) => item.repositoryId), ["git-repo", "jj-repo"]);
  assert.deepEqual(first.filters.repositoryIds, ["git-repo", "jj-repo"]);
});

test("query text normalization is conservative", () => {
  const normalized = canonicalizeRetrievalQuery(input({ text: "  Trace\u00a0ＣodeService\n retrieval  " }));
  const equivalent = canonicalizeRetrievalQuery(input({ text: "Trace CodeService retrieval" }));
  assert.equal(normalized.digest, equivalent.digest);

  for (const text of ["trace CodeService retrieval", "Trace CodeService retrieval!", "Trace retrieval CodeService"]) {
    assert.notEqual(canonicalizeRetrievalQuery(input({ text })).digest, equivalent.digest, text);
  }
});

test("every semantic key field isolates canonical queries", () => {
  const base = canonicalizeRetrievalQuery(input()).digest;
  const variants: CanonicalQueryInput[] = [
    input({ operation: "symbols" }),
    input({ operation: "relationships", filters: { ...input().filters, reference: { provider: "codesearch", opaqueId: "chunk-a", repositoryId: "git-repo", path: "src/a.ts" } } }),
    input({ operation: "relationships", filters: { ...input().filters, reference: { provider: "codesearch", opaqueId: "chunk-b", repositoryId: "git-repo", path: "src/a.ts" } } }),
    input({ text: "Trace CodeService cache" }),
    input({ provider: { name: "octocode", version: "1.1.30", instanceId: "local" } }),
    input({ provider: { name: "codesearch", version: "1.1.31", instanceId: "local" } }),
    input({ provider: { name: "codesearch", version: "1.1.30", instanceId: "remote" } }),
    input({ workspaceId: "other-workspace" }),
    input({ repositories: [{ repositoryId: "git-repo", snapshot: gitSnapshot }] }),
    input({ repositories: [{ repositoryId: "git-repo", snapshot: { ...gitSnapshot, repositoryId: "different-underlying-repo" } }, { repositoryId: "jj-repo", snapshot: jjSnapshot }] }),
    input({ repositories: [{ repositoryId: "git-repo", snapshot: { ...gitSnapshot, headCommit: "next" } }, { repositoryId: "jj-repo", snapshot: jjSnapshot }] }),
    input({ repositories: [{ repositoryId: "git-repo", snapshot: gitSnapshot }, { repositoryId: "jj-repo", snapshot: { ...jjSnapshot, operationId: "next-op" } }] }),
    input({ indexRevision: "index-b" }),
    input({ mode: "hybrid" }),
    input({ focus: "tests" }),
    input({ filters: { ...input().filters, includeTests: false } }),
  ];

  for (const variant of variants) assert.notEqual(canonicalizeRetrievalQuery(variant).digest, base);
});

test("relationship reference identity is operation-specific", () => {
  const reference = { provider: "codesearch", opaqueId: "chunk-a", repositoryId: "git-repo", path: "src/a.ts" };
  const first = canonicalizeRetrievalQuery(input({ operation: "relationships", filters: { ...input().filters, reference } }));
  const second = canonicalizeRetrievalQuery(input({ operation: "relationships", filters: { ...input().filters, reference: { ...reference, opaqueId: "chunk-b" } } }));
  assert.notEqual(first.digest, second.digest);
});

test("requested limit does not change identity and only covered lower limits are reusable", () => {
  const larger = canonicalizeRetrievalQuery(input({ requestedLimit: 10 }));
  const smaller = canonicalizeRetrievalQuery(input({ requestedLimit: 4 }));
  assert.equal(larger.digest, smaller.digest);
  assert.equal(decideCanonicalQueryReuse({
    query: larger,
    coveredLimit: 10,
    complete: true,
    truncated: false,
    degraded: false,
    freshness: "current",
  }, smaller).kind, "exact_reuse");
  assert.deepEqual(decideCanonicalQueryReuse({
    query: smaller,
    coveredLimit: 4,
    complete: true,
    truncated: false,
    degraded: false,
    freshness: "current",
  }, larger), {
    kind: "provider_call",
    reason: "cached result covers 4 result(s), below requested limit 10",
  });
});

test("evidence identity is provider, workspace, repository, revision, and location qualified", () => {
  const evidence = {
    kind: "symbol" as const,
    provider: input().provider,
    workspaceId: "workspace",
    repositoryId: "git-repo",
    repositoryRevision: "git-head",
    path: "packages/core/src/code/service.ts",
    startLine: 12,
    endLine: 20,
    symbol: "CodeService",
    opaqueId: "chunk-1",
  };
  const first = canonicalizeEvidenceIdentity(evidence);
  const same = canonicalizeEvidenceIdentity({ ...evidence });
  const otherRepository = canonicalizeEvidenceIdentity({
    kind: "symbol",
    provider: input().provider,
    workspaceId: "workspace",
    repositoryId: "jj-repo",
    repositoryRevision: "git-head",
    path: "packages/core/src/code/service.ts",
    startLine: 12,
    endLine: 20,
    symbol: "CodeService",
    opaqueId: "chunk-1",
  });
  assert.equal(first.digest, same.digest);
  assert.notEqual(first.digest, otherRepository.digest);
  assert.deepEqual(
    canonicalizeEvidenceIdentities([otherRepository, first]).map((item) => item.digest),
    canonicalizeEvidenceIdentities([first, otherRepository]).map((item) => item.digest),
  );
});

test("empty normalized text and invalid limits are rejected", () => {
  assert.throws(() => canonicalizeRetrievalQuery(input({ text: " \n\t " })), /query text/i);
  assert.throws(() => canonicalizeRetrievalQuery(input({ requestedLimit: 0 })), /requestedLimit/);
});

test("provider index revisions are optional and capability-gated", async () => {
  const mock = new MockCodeProvider();
  const before = await mock.status();
  assert.equal(before.indexRevision, undefined);
  assert.equal(before.capabilities.includes("index.revision_aware"), false);

  await mock.ensureIndex({ id: "workspace", name: "workspace", roots: [], repositories: [] });
  const after = await mock.status();
  assert.match(after.indexRevision ?? "", /^[a-f0-9]{64}$/);
  assert.equal(after.capabilities.includes("index.revision_aware"), true);

  const disabled = await new DisabledCodeProvider().status();
  assert.equal(disabled.indexRevision, undefined);
  assert.equal(disabled.capabilities.includes("index.revision_aware"), false);
});
