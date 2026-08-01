import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizeWorkspaceEffects } from "../apps/pi-extension/src/tool-authorization.ts";
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
    assert.equal(repositorySamples.at(-1)?.cache, "hit", "the repeated status should reuse the bounded observation cache");
    assert.ok(core.performanceReport().interactive.latest.some((sample) => sample.operation === "/status" && sample.phase === "total"));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
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
