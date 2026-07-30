import assert from "node:assert/strict";
import test from "node:test";
import { installAtelierFooter } from "../apps/pi-extension/src/status-presentation.ts";

const status = {
  snapshot: { vcs: "jj", changeId: "abcdefgh123", headCommit: "12345678" },
} as any;

test("Atelier footer preserves exposed Pi session metrics and truncates narrow terminals", () => {
  let component: any;
  const ctx = {
    mode: "tui",
    model: { id: "gpt-test" },
    getContextUsage: () => ({ percent: 42 }),
    ui: { setFooter: (factory: any) => { component = factory?.({}, {}, { cost: 1.25, tokens: 900, sessionName: "session" }); } },
  } as any;
  installAtelierFooter(ctx, status, "Atelier act", "atelier");
  const wide = component.render(240)[0];
  assert.match(wide, /session/);
  assert.match(wide, /900 tokens/);
  assert.match(wide, /\$1\.250/);
  assert.ok(component.render(24)[0].length <= 24);
});

test("status-only and disabled footer modes release Pi footer ownership", () => {
  const values: unknown[] = [];
  const ctx = { mode: "tui", ui: { setFooter: (value: unknown) => values.push(value) } } as any;
  installAtelierFooter(ctx, status, "Atelier", "status-only");
  installAtelierFooter(ctx, status, "Atelier", "disabled");
  assert.deepEqual(values, [undefined, undefined]);
});
