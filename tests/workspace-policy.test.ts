import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  establishSessionWorkspace,
  WorkspacePolicyEvaluator,
  type RepositoryPathState,
} from "../packages/core/src/index.ts";

const resolver = (states: Record<string, RepositoryPathState>) => ({
  classify(path: string) { return states[path] ?? "missing" as const; },
});

test("startup directory establishes one immutable canonical workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-workspace-"));
  const nested = join(root, "nested");
  mkdirSync(nested);
  const workspace = establishSessionWorkspace(nested);
  assert.equal(workspace.root, resolve(nested));
  assert.equal(workspace.source, "startup_cwd");
});

test("workspace policy allows recoverable work and asks for protected consequences", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-policy-"));
  const tracked = join(root, "tracked.ts");
  const dirty = join(root, "dirty.ts");
  const untracked = join(root, "notes.txt");
  writeFileSync(tracked, "a");
  writeFileSync(dirty, "b");
  writeFileSync(untracked, "c");
  const evaluator = new WorkspacePolicyEvaluator({ root });
  const states = resolver({ [tracked]: "tracked_clean", [dirty]: "tracked_dirty", [untracked]: "untracked" });
  assert.equal(evaluator.evaluate([{ kind: "read", path: tracked }], states).result, "allow");
  assert.equal(evaluator.evaluate([{ kind: "mutate", path: tracked }], states).result, "allow");
  assert.equal(evaluator.evaluate([{ kind: "delete", path: dirty, destructive: true }], states).result, "checkpoint_then_allow");
  assert.equal(evaluator.evaluate([{ kind: "delete", path: untracked, destructive: true }], states).result, "checkpoint_then_allow");
  assert.equal(evaluator.evaluate([{ kind: "read", path: join(root, ".env") }], states).result, "ask");
  assert.equal(evaluator.evaluate([{ kind: "create", path: join(root, "new.ts") }], states).result, "allow");
  assert.equal(evaluator.evaluate([{ kind: "create", path: join(root, "..", "outside.ts") }], states).result, "ask");
  assert.equal(evaluator.evaluate([{ kind: "privilege_escalation" }], states).result, "ask");
});

test("workspace guard rejects descendants of an escaping symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "atlr-outside-"));
  symlinkSync(outside, join(root, "escape"));
  const evaluator = new WorkspacePolicyEvaluator({ root });
  const decision = evaluator.evaluate([{ kind: "create", path: join(root, "escape", "file") }], resolver({}));
  assert.equal(decision.result, "ask");
  assert.equal(decision.effects[0]?.state, "outside_workspace");
});
