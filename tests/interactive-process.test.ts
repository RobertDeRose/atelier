import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runInteractiveProcessWithPi } from "../apps/pi-extension/src/interactive-process.ts";

test("interactive child processes suspend and restore Pi's TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-pi-interactive-process-"));
  const marker = join(root, "marker.txt");
  const calls: string[] = [];
  const context = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => await new Promise((resolve) => {
        const tui = {
          stop(): void { calls.push("stop"); },
          start(): void { calls.push("start"); },
          requestRender(force?: boolean): void { calls.push(`render:${String(force)}`); },
        };
        const component = factory(tui, {}, {}, resolve);
        assert.deepEqual(component.render(120), []);
      }),
    },
  } as unknown as ExtensionContext;

  try {
    const result = await runInteractiveProcessWithPi(context, {
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'child-ran')`],
      cwd: root,
      purpose: "test interactive child",
    });

    assert.equal(result.exitCode, 0, result.error);
    assert.equal(readFileSync(marker, "utf8"), "child-ran");
    assert.deepEqual(calls, ["stop", "start", "render:true"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive child processes fail clearly outside Pi TUI mode", async () => {
  const context = { mode: "json" } as unknown as ExtensionContext;
  await assert.rejects(
    runInteractiveProcessWithPi(context, {
      command: process.execPath,
      cwd: process.cwd(),
      purpose: "repository navigation",
    }),
    /repository navigation requires Pi TUI mode/,
  );
});
