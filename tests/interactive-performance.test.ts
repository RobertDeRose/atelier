import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizeWorkspaceEffects } from "../apps/pi-extension/src/tool-authorization.ts";
import { clearAtelierPhase, showAtelierPhase } from "../apps/pi-extension/src/working-phase.ts";
import { AtelierCore } from "../packages/core/src/core.ts";
import { createTemporaryRepository } from "./fixtures.ts";

test("interactive status yields to the event loop and reuses one cached repository observation", async () => {
  const root = createTemporaryRepository("atlr-interactive-status-");
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  try {
    let observations = 0;
    const originalObserve = core.observeRepository.bind(core);
    core.observeRepository = async (options = {}) => {
      observations += 1;
      return originalObserve(options);
    };

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    await core.status();
    clearTimeout(timer);
    assert.equal(timerFired, true, "asynchronous repository observation must not block Pi's event loop");
    assert.equal(observations, 1, "one status request must take one primary repository observation");

    await core.status();
    assert.equal(observations, 2, "each status request owns one observation instead of hidden duplicates");
    const repositorySamples = core.performanceReport().interactive.latest
      .filter((sample) => sample.operation === "status" && sample.phase === "repository.observe");
    assert.ok((repositorySamples[0]?.subprocesses ?? Number.POSITIVE_INFINITY) <= 6,
      `one Git status observation used too many subprocesses: ${repositorySamples[0]?.subprocesses}`);
    assert.equal(repositorySamples.at(-1)?.cache, "hit", "the repeated status should reuse the bounded observation cache");
    assert.equal(repositorySamples.at(-1)?.subprocesses, 0, "a cached status observation must not launch VCS subprocesses");
    assert.equal(repositorySamples.at(-1)?.filesHashed, 0, "a cached status observation must not rehash source files");
    assert.ok(core.performanceReport().interactive.latest.some((sample) => sample.operation === "/status" && sample.phase === "total"));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("interactive phase feedback is visible before delayed work starts", async () => {
  const messages: Array<string | undefined> = [];
  const widgets: Array<{
    key: string;
    content: unknown;
    placement?: "aboveEditor" | "belowEditor";
  }> = [];
  const context = {
    mode: "tui",
    isIdle: () => true,
    ui: {
      setWorkingMessage(message?: string): void { messages.push(message); },
      setWidget(key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }): void {
        widgets.push({ key, content, ...(options?.placement === undefined ? {} : { placement: options.placement }) });
      },
    },
  } as unknown as ExtensionContext;

  const pending = showAtelierPhase(context, "reading repository state");
  assert.equal(messages[0], "Atelier: reading repository state…",
    "the first feedback must be installed synchronously before provider work begins");
  assert.equal(widgets[0]?.key, "atelier-phase");
  assert.equal(widgets[0]?.placement, "aboveEditor");
  assert.equal(typeof widgets[0]?.content, "function");
  const component = (widgets[0]!.content as (
    tui: { requestRender(): void },
    theme: unknown,
  ) => { render(width: number): string[]; dispose?(): void })(
    { requestRender(): void {} },
    {},
  );
  assert.match(component.render(120)[0] ?? "", /Atelier: reading repository state…/);
  assert.equal(component.render(120).length, 1, "the idle phase must occupy exactly one transient line");
  component.dispose?.();
  await pending;
});



test("agent lifecycle can force Pi's native working indicator while the context still reports idle", async () => {
  const messages: Array<string | undefined> = [];
  const widgets: Array<{ key: string; content: unknown }> = [];
  const context = {
    mode: "tui",
    isIdle: () => true,
    ui: {
      setWorkingMessage(message?: string): void { messages.push(message); },
      setWidget(key: string, content: unknown): void { widgets.push({ key, content }); },
    },
  } as unknown as ExtensionContext;

  await showAtelierPhase(context, "building authoritative working state", { surface: "native" });
  assert.equal(messages[0], "Atelier: building authoritative working state…");
  assert.equal(widgets.length, 0, "a forced native phase must not install the idle spinner");
  clearAtelierPhase(context);
  assert.equal(messages.at(-1), undefined);
});

test("explicit checkpoint approval is shown before Atelier copies recovery state", async () => {
  const root = createTemporaryRepository("atlr-checkpoint-prompt-order-");
  const target = join(root, "untracked.txt");
  writeFileSync(target, "recoverable\n", "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  const order: string[] = [];
  const originalCheckpoint = core.checkpointWorkspaceEffects.bind(core);
  core.checkpointWorkspaceEffects = ((decision, options) => {
    order.push("checkpoint");
    return originalCheckpoint(decision, options);
  }) as typeof core.checkpointWorkspaceEffects;
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      setWorkingMessage(): void {},
      confirm: async () => { order.push("confirm"); return true; },
    },
  } as unknown as ExtensionContext;
  try {
    const result = await authorizeWorkspaceEffects(
      [{ kind: "delete", path: target, destructive: true }],
      context,
      core,
      { requireExplicitApproval: true, toolCallId: "checkpoint-order" },
    );
    assert.equal(result.response, undefined);
    assert.ok(result.checkpointId);
    assert.deepEqual(order, ["confirm", "checkpoint"]);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
