import assert from "node:assert/strict";
import test from "node:test";
import { resolveSandboxBackend, sandboxCommand } from "../packages/core/src/sandbox/sandbox.ts";

test("sandbox backend selection is explicit and fail-closed", () => {
  assert.deepEqual(resolveSandboxBackend("none"), { backend: "none", available: false, detail: "Sandbox explicitly disabled." });
  assert.throws(() => sandboxCommand({ backend: "none", available: false, detail: "unavailable" }, "/workspace", "echo ok"), /unavailable/);
});

test("sandbox command plans preserve one writable workspace and disable network by default", () => {
  const seatbelt = sandboxCommand({ backend: "seatbelt", available: true, detail: "test" }, "/workspace", "echo ok");
  assert.equal(seatbelt.command, "sandbox-exec");
  assert.equal(seatbelt.args.at(-2), "-c");
  assert.equal(seatbelt.args.includes("-lc"), false);
  assert.match(seatbelt.args.join(" "), /deny network/);
  assert.match(seatbelt.args.join(" "), /workspace/);
  const bwrap = sandboxCommand({ backend: "bubblewrap", available: true, detail: "test" }, "/workspace", "echo ok");
  assert.equal(bwrap.command, "bwrap");
  assert.equal(bwrap.args.at(-2), "-c");
  assert.equal(bwrap.args.includes("-lc"), false);
  assert.ok(bwrap.args.includes("--unshare-all"));
  assert.ok(!bwrap.args.includes("--share-net"));
});
