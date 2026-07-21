import test from "node:test";
import assert from "node:assert/strict";
import atelierExtension from "../apps/pi-extension/src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("Pi extension registers policy, Working State, compaction, plan, and task hooks", () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const fakePi = {
    on(name: string): void { events.add(name); },
    registerCommand(name: string): void { commands.add(name); },
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  atelierExtension(fakePi);

  for (const event of [
    "session_start",
    "session_shutdown",
    "tool_call",
    "before_agent_start",
    "session_before_compact",
    "agent_settled",
  ]) {
    assert.ok(events.has(event), `missing event ${event}`);
  }
  for (const command of ["status", "plan", "review", "approve", "ready", "state", "code-status", "code-index", "code-search", "code-symbols", "changed", "validate", "evidence"]) {
    assert.ok(commands.has(command), `missing command ${command}`);
  }
});
