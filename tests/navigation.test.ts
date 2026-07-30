import assert from "node:assert/strict";
import test from "node:test";
import { editorArguments, parseFileLocation } from "../apps/pi-extension/src/navigation.ts";

test("navigation parses file locations and opens Helix at an exact line", () => {
  const location = parseFileLocation("src/core.ts:42", "/workspace");
  assert.deepEqual(location, { path: "/workspace/src/core.ts", line: 42 });
  assert.deepEqual(editorArguments({ executable: "hx", args: [], source: "atlr" }, location), ["/workspace/src/core.ts:42"]);
});
