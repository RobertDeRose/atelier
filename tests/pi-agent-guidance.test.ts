import assert from "node:assert/strict";
import test from "node:test";
import { atelierAgentProtocol } from "../apps/pi-extension/src/atelier-agent-guidance.ts";

test("Atelier protocol teaches the model the state and retrieval sequence", () => {
  const prompt = atelierAgentProtocol({ mode: "act", codeIntelligence: "enabled" });

  assert.match(prompt, /Working State as authoritative/i);
  assert.match(prompt, /Beads/i);
  assert.match(prompt, /Jujutsu\/Git/i);
  assert.match(prompt, /atlr_state/);
  assert.match(prompt, /atlr_code_status/);
  assert.match(prompt, /atlr_code_search/);
  assert.match(prompt, /focus.*source/i);
  assert.match(prompt, /atlr_code_symbols.*unresolved/i);
  assert.match(prompt, /atlr_validate/);
  assert.match(prompt, /atlr_commit/);
  assert.match(prompt, /atlr_task_close/);
  assert.match(prompt, /do not.*(?:bd|jj|git).*inspection/i);
  assert.ok(prompt.length < 2_400, "the protocol must remain compact enough to save context");
});

test("Atelier protocol degrades clearly when code intelligence is disabled", () => {
  const prompt = atelierAgentProtocol({ mode: "investigate", codeIntelligence: "disabled" });

  assert.match(prompt, /code intelligence is disabled/i);
  assert.doesNotMatch(prompt, /atlr_code_search/);
  assert.match(prompt, /Investigate only/i);
});
