import assert from "node:assert/strict";
import test from "node:test";
import { codeResultCategory, rankPresentedHits, usefulCodePreview } from "../packages/core/src/code/result-presentation.ts";

test("code presentation ranks exact definitions before references, tests, docs, and generated paths", () => {
  const hits = [
    { rank: 1, path: "tests/core.test.ts", symbol: "function helper(core: AtelierCore)", repositoryId: "r", repositoryName: "r", reference: "a", provenance: {} },
    { rank: 2, path: "packages/core/src/core.ts", symbol: "class AtelierCore", repositoryId: "r", repositoryName: "r", reference: "b", provenance: {} },
    { rank: 3, path: "docs/core.md", symbol: "block (10 lines)", repositoryId: "r", repositoryName: "r", reference: "c", provenance: {} },
  ] as any[];
  const ranked = rankPresentedHits(hits);
  assert.equal(ranked[0].path, "packages/core/src/core.ts");
  assert.equal(codeResultCategory(ranked[0]), "definition");
  assert.equal(usefulCodePreview({ preview: "block (11 lines)", symbol: "class AtelierCore" }), "class AtelierCore");
});
