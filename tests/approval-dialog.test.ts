import assert from "node:assert/strict";
import test from "node:test";
import { renderApprovalDialog } from "../apps/pi-extension/src/approval-dialog.ts";

test("dedicated approval dialog keeps scope visible and supports narrow terminals", () => {
  const lines = ["Writes:", "  src/a.ts", "Dependencies: not permitted", "Validation: focused"];
  const rendered = renderApprovalDialog({ title: "Approve", lines }, 32);
  assert.ok(rendered.some((line) => line.includes("src/a.ts")));
  assert.ok(rendered.some((line) => line.includes("Enter/y")));
  assert.ok(rendered.every((line) => line.length <= 32));
});
