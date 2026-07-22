import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodePath,
  inferCodeSearchFocus,
  rankCodePathsByFocus,
} from "../packages/core/src/index.ts";

test("code search focus infers source, tests, docs, and neutral queries", () => {
  assert.equal(inferCodeSearchFocus("How does the CLI dispatch this command?"), "source");
  assert.equal(inferCodeSearchFocus("Which tests verify codesearch normalization?"), "tests");
  assert.equal(inferCodeSearchFocus("Why did ADR-0003 choose codesearch?"), "docs");
  assert.equal(inferCodeSearchFocus("authentication session"), "all");
});

test("code path classification separates product source from tests, docs, and tooling", () => {
  assert.equal(classifyCodePath("packages/core/src/core.ts"), "source");
  assert.equal(classifyCodePath("tests/core.test.ts"), "tests");
  assert.equal(classifyCodePath("docs/ARCHITECTURE.md"), "docs");
  assert.equal(classifyCodePath("scripts/probe.ts"), "tooling");
});

test("focused path ranking preserves provider order within each path class", () => {
  const input = [
    "docs/ARCHITECTURE.md",
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
    "docs/ARCHITECTURE.md",
  ]);
  assert.deepEqual(rankCodePathsByFocus(input, "tests", "tests").paths.slice(0, 2), [
    "tests/core.test.ts",
    "packages/core/src/core.ts",
  ]);
});
