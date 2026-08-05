import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryActionDialog,
  renderApprovalDialog,
  renderRecoveryDialog,
} from "../apps/pi-extension/src/approval-dialog.ts";

test("dedicated approval dialog keeps scope visible and supports narrow terminals", () => {
  const lines = ["Writes:", "  src/a.ts", "Dependencies: not permitted", "Validation: focused"];
  const rendered = renderApprovalDialog({ title: "Approve", lines }, 32);
  assert.ok(rendered.some((line) => line.includes("src/a.ts")));
  assert.ok(rendered.some((line) => line.includes("Enter/y")));
  assert.ok(rendered.every((line) => line.length <= 32));
});

test("recovery dialog renders a framed task summary and selectable actions", () => {
  const rendered = renderRecoveryDialog("atelier-mw9", 72, "Expand the User Guide");
  const text = rendered.join("\n");
  assert.match(rendered[0] ?? "", /^╭.*╮$/);
  assert.ok(rendered.some((line) => line.includes("Enter confirm")));
  assert.match(text, /atelier-mw9/);
  assert.match(text, /Expand the User Guide/);
  assert.match(text, /Continue task/);
  assert.match(text, /Pause/);
  assert.match(text, /Cancel/);
  assert.ok(rendered.every((line) => Array.from(line).length <= 72));
});

test("recovery dialog is a centered overlay and accepts the terminal Enter key", async () => {
  let options: any;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any, receivedOptions: any) => {
        options = receivedOptions;
        return await new Promise((resolve) => {
          const component = factory({}, {}, {}, resolve);
          component.handleInput("\r");
        });
      },
    },
  } as any;
  const action = await Promise.race([
    recoveryActionDialog(ctx, "atelier-mw9"),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);
  assert.equal(action, "continue");
  assert.equal(options?.overlay, true);
  assert.equal(options?.overlayOptions?.anchor, "center");
});

test("recovery dialog accepts a raw terminal Escape key without mutating state", async () => {
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => await new Promise((resolve) => {
        const component = factory({}, {}, {}, resolve);
        component.handleInput("\x1b");
      }),
    },
  } as any;
  const action = await Promise.race([
    recoveryActionDialog(ctx, "atelier-mw9"),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);
  assert.equal(action, undefined);
});
