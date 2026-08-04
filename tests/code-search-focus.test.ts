import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodePath,
  inferCodeSearchFocus,
  rankCodePathsByFocus,
} from "../packages/core/src/index.ts";

test("code search focus infers source, tests, mixed, docs, and neutral queries", () => {
  assert.equal(inferCodeSearchFocus("How does the CLI dispatch this command?"), "source");
  assert.equal(inferCodeSearchFocus("Which tests verify codesearch normalization?"), "tests");
  assert.equal(inferCodeSearchFocus("Where are responses normalized, and which tests verify that normalization?"), "mixed");
  assert.equal(inferCodeSearchFocus("Why is codesearch used by Atelier?"), "docs");
  assert.equal(inferCodeSearchFocus("authentication session"), "all");
});

test("code path classification separates product source from tests, docs, and tooling", () => {
  assert.equal(classifyCodePath("packages/core/src/core.ts"), "source");
  assert.equal(classifyCodePath("tests/core.test.ts"), "tests");
  assert.equal(classifyCodePath("docs/src/architecture/overview.md"), "docs");
  assert.equal(classifyCodePath("scripts/probe.ts"), "tooling");
});

test("focused path ranking preserves provider order within each path class", () => {
  const input = [
    "docs/src/architecture/overview.md",
    "scripts/probe.ts",
    "packages/core/src/core.ts",
    "tests/core.test.ts",
    "packages/core/src/code/service.ts",
  ];
  assert.deepEqual(rankCodePathsByFocus(input, "source", "implementation").paths, [
    "packages/core/src/core.ts",
    "packages/core/src/code/service.ts",
    "scripts/probe.ts",
    "tests/core.test.ts",
    "docs/src/architecture/overview.md",
  ]);
  assert.deepEqual(rankCodePathsByFocus(input, "tests", "tests").paths.slice(0, 2), [
    "tests/core.test.ts",
    "packages/core/src/core.ts",
  ]);
  assert.deepEqual(rankCodePathsByFocus(input, "auto", "Where is this implemented and which tests verify it?").paths.slice(0, 4), [
    "packages/core/src/core.ts",
    "tests/core.test.ts",
    "packages/core/src/code/service.ts",
    "scripts/probe.ts",
  ]);
});
