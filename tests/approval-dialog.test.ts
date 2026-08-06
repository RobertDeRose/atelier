import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  recoveryActionDialog,
  renderApprovalDialog,
} from "../apps/pi-extension/src/approval-dialog.ts";

test("dedicated approval dialog keeps scope visible and supports narrow terminals", () => {
  const lines = ["Writes:", "  src/a.ts", "Dependencies: not permitted", "Validation: focused"];
  const rendered = renderApprovalDialog({ title: "Approve", lines }, 32);
  assert.ok(rendered.some((line) => line.includes("src/a.ts")));
  assert.ok(rendered.some((line) => line.includes("Enter/y")));
  assert.ok(rendered.every((line) => line.length <= 32));
});

test("recovery action uses Pi's native select dialog", async () => {
  let title = "";
  let options: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      select: async (receivedTitle: string, receivedOptions: string[]) => {
        title = receivedTitle;
        options = receivedOptions;
        return receivedOptions[0];
      },
    },
  } as unknown as ExtensionContext;

  const action = await recoveryActionDialog(ctx, "atelier-mw9", "Expand the User Guide");
  assert.equal(action, "continue");
  assert.match(title, /atelier-mw9/);
  assert.match(title, /Expand the User Guide/);
  assert.deepEqual(options, [
    "Continue task — send one explicit agent turn",
    "Pause — keep task and files, disable mutation",
    "Cancel — revoke execution, leave task open",
  ]);
});

test("native recovery select maps cancellation to idle", async () => {
  const ctx = {
    mode: "tui",
    ui: { select: async () => undefined },
  } as unknown as ExtensionContext;
  assert.equal(await recoveryActionDialog(ctx, "atelier-mw9"), undefined);
});
