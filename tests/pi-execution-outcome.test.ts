import assert from "node:assert/strict";
import test from "node:test";
import { toolExecutionOutcome } from "../apps/pi-extension/src/execution-outcome.ts";

test("Pi tool outcome classification does not infer interruption from arbitrary error text", () => {
  assert.deepEqual(toolExecutionOutcome({
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "ReferenceError: signal is not defined\nCommand exited with code 1" }],
  }), {
    status: "failed",
    error: "ReferenceError: signal is not defined\nCommand exited with code 1",
  });

  assert.equal(toolExecutionOutcome({
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "Operation failed while reading AbortSignal metadata\nCommand exited with code 1" }],
  }).status, "failed");
});

test("Pi tool outcome classification uses abort state or the exact Bash abort sentinel", () => {
  assert.equal(toolExecutionOutcome({
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "Command aborted" }],
  }).status, "interrupted");

  const controller = new AbortController();
  controller.abort();
  assert.equal(toolExecutionOutcome({
    toolName: "edit",
    isError: true,
    content: [{ type: "text", text: "replacement did not match" }],
  }, controller.signal).status, "interrupted");

  assert.equal(toolExecutionOutcome({
    toolName: "custom",
    isError: true,
    content: [{ type: "text", text: "failed" }],
    details: { interrupted: true },
  }).status, "interrupted");
});
