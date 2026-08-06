import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import test from "node:test";
import { AtelierCore } from "../packages/core/src/core.ts";
import { DisabledCodeProvider } from "../packages/core/src/code/disabled-provider.ts";
import { createTemporaryRepository } from "./fixtures.ts";
import {
  ContextCapsuleCache,
  buildContextCapsule,
  contextBoundaryDigest,
} from "../packages/core/src/context/context-capsule.ts";

const source = {
  id: "beads:task-1",
  kind: "beads",
  digest: "beads-digest",
  freshness: "current" as const,
  boundary: "task-1",
};

function section(value: unknown, budgetClass?: "items" | "history" | "retrieval") {
  return {
    name: "task",
    kind: "beads" as const,
    sources: [source],
    value,
    ...(budgetClass === undefined ? {} : { budgetClass }),
  };
}

test("context capsules are deterministic, redacted, and provenance-rich", () => {
  const input = {
    boundary: { snapshot: "snapshot-1", task: "task-1", provider: "beads" },
    sections: [section({ z: "last", secret: "password=do-not-leak", a: "first" })],
  };
  const first = buildContextCapsule(input);
  const second = buildContextCapsule({
    ...input,
    boundary: { provider: "beads", task: "task-1", snapshot: "snapshot-1" },
    sections: [section({ a: "first", secret: "password=do-not-leak", z: "last" })],
  });

  assert.equal(first.digest, second.digest);
  assert.equal(first.boundaryDigest, contextBoundaryDigest(input.boundary));
  assert.equal(first.sections[0]?.sources[0]?.id, source.id);
  assert.equal(first.sections[0]?.sourceDigest, source.digest);
  assert.doesNotMatch(first.markdown, /do-not-leak/);
  assert.match(first.markdown, /beads:task-1/);
  assert.equal(first.truncated, false);
  assert.deepEqual(first.omissions, []);
});

test("context capsules enforce item, history, retrieval, and byte budgets", () => {
  const capsule = buildContextCapsule({
    boundary: "bounded",
    budgets: { maxBytes: 220, maxOutputBytes: 180, maxItems: 4, maxHistory: 2, maxRetrieval: 1 },
    sections: [
      { ...section(Array.from({ length: 10 }, (_, index) => `history-${index}`), "history"), name: "history" },
      { ...section(Array.from({ length: 10 }, (_, index) => `result-${index}`), "retrieval"), name: "retrieval" },
      { ...section({ events: Array.from({ length: 10 }, (_, index) => `event-${index}`) }, "history"), name: "nested-history" },
      { ...section("x".repeat(500)), name: "large" },
    ],
  });

  assert.ok(capsule.truncated);
  assert.ok(capsule.sections.some((item) => item.truncated));
  assert.ok(capsule.omissions.length > 0 || capsule.sections.some((item) => item.omitted.length > 0));
  assert.ok(capsule.sections.reduce((total, item) => total + item.bytes, 0) <= 220);
  assert.ok(Buffer.byteLength(capsule.markdown, "utf8") <= 180);
  const history = capsule.sections.find((item) => item.name === "history");
  const retrieval = capsule.sections.find((item) => item.name === "retrieval");
  const nestedHistory = capsule.sections.find((item) => item.name === "nested-history");
  assert.equal((history?.value as string[]).length, 2);
  assert.equal((retrieval?.value as string[]).length, 1);
  assert.equal(((nestedHistory?.value as { events: string[] }).events).length, 2);
});

test("Core composes scoped sources and invalidates the capsule when a document changes", async () => {
  const root = createTemporaryRepository("atlr-context-capsule-");
  const core = AtelierCore.open(root, { codeProvider: new DisabledCodeProvider() });
  try {
    const first = await core.buildContextCapsule({
      documentPaths: ["README.md", "missing-design.md"],
      gateInventory: [{ name: "docs", command: "mise run docs:check" }],
      budgets: { maxBytes: 8_000, maxItems: 8, maxHistory: 4, maxRetrieval: 2 },
    });
    const reused = await core.buildContextCapsule({
      documentPaths: ["README.md", "missing-design.md"],
      gateInventory: [{ name: "docs", command: "mise run docs:check" }],
      budgets: { maxBytes: 8_000, maxItems: 8, maxHistory: 4, maxRetrieval: 2 },
    });

    assert.equal(reused.reused, true);
    assert.deepEqual(first.sections.map((item) => item.name), [
      "task",
      "working_state",
      "snapshot",
      "code",
      "reviews",
      "quality_gates",
      "documents",
    ]);
    assert.ok(first.omissions.some((item) => item.includes("missing-design.md")));
    for (const capsuleSection of first.sections) {
      assert.ok(capsuleSection.sources.length > 0);
      assert.ok(capsuleSection.sources.every((item) => item.digest.length > 0));
    }

    appendFileSync(`${root}/README.md`, "\nchanged\n", "utf8");
    const changed = await core.buildContextCapsule({ documentPaths: ["README.md"] });
    assert.equal(changed.reused, false);
    assert.notEqual(changed.digest, first.digest);
  } finally {
    await core.close();
  }
});

test("unchanged context capsules are reused only within the same boundary", () => {
  const cache = new ContextCapsuleCache();
  let builds = 0;
  const build = () => {
    builds += 1;
    return buildContextCapsule({ boundary: `boundary-${builds}`, sections: [section([builds])] });
  };

  const first = cache.getOrBuild("boundary-1", build);
  const reused = cache.getOrBuild("boundary-1", build);
  const changed = cache.getOrBuild("boundary-2", build);

  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(reused.digest, first.digest);
  assert.equal(changed.reused, false);
  assert.equal(builds, 2);
});
