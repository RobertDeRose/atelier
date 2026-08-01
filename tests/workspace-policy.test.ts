import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.equal(workspace.root, realpathSync.native(nested));
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
  const canonicalTracked = realpathSync.native(tracked);
  const canonicalDirty = realpathSync.native(dirty);
  const canonicalUntracked = realpathSync.native(untracked);
  const states = resolver({ [canonicalTracked]: "tracked_clean", [canonicalDirty]: "tracked_dirty", [canonicalUntracked]: "untracked" });
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


test("explicit workspace selection is canonical and remains immutable after process directory changes", () => {
  const startup = mkdtempSync(join(tmpdir(), "atlr-startup-cwd-"));
  const explicit = mkdtempSync(join(tmpdir(), "atlr-explicit-workspace-"));
  const alias = join(startup, "workspace-alias");
  symlinkSync(explicit, alias, "dir");
  const original = process.cwd();
  try {
    const workspace = establishSessionWorkspace(startup, alias);
    assert.equal(workspace.root, realpathSync.native(explicit));
    assert.equal(workspace.source, "explicit");
    process.chdir(startup);
    assert.equal(workspace.root, realpathSync.native(explicit));
    process.chdir(explicit);
    assert.equal(workspace.root, realpathSync.native(explicit));
  } finally {
    process.chdir(original);
  }
});

test("runtime confinement does not by itself make unknown destructive effects recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-confined-unknown-"));
  const evaluator = new WorkspacePolicyEvaluator({ root });
  const decision = evaluator.evaluate([{
    kind: "execute",
    path: root,
    runtimeConfined: true,
    description: "unknown build script",
  }], resolver({ [root]: "tracked_dirty" }));
  assert.equal(decision.result, "ask");
  assert.match(decision.reason, /cannot guarantee recovery/i);
});

test("secret classification is narrow and does not treat every ignored path as protected", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-secret-policy-"));
  const evaluator = new WorkspacePolicyEvaluator({ root });
  const states = resolver({
    [join(root, ".env.local")]: "ignored",
    [join(root, "dist", "bundle.js")]: "ignored",
  });
  assert.equal(evaluator.evaluate([{ kind: "read", path: join(root, ".env.local") }], states).result, "ask");
  assert.equal(evaluator.evaluate([{ kind: "read", path: join(root, "dist", "bundle.js") }], states).result, "allow");
});

test("workspace policy keeps final symlink entry identity separate from its resolved target", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-policy-symlink-entry-"));
  const target = join(root, "target.txt");
  const link = join(root, "tracked-link");
  const secretLink = join(root, ".env");
  writeFileSync(target, "target\n", "utf8");
  symlinkSync("target.txt", link);
  symlinkSync("target.txt", secretLink);

  const evaluator = new WorkspacePolicyEvaluator({ root });
  const canonicalRoot = realpathSync.native(root);
  const canonicalTarget = realpathSync.native(target);
  const canonicalLinkEntry = join(canonicalRoot, "tracked-link");
  const states = resolver({
    [canonicalLinkEntry]: "tracked_dirty",
    [canonicalTarget]: "tracked_clean",
  });

  const deletion = evaluator.evaluate([{ kind: "delete", path: link, destructive: true }], states);
  assert.equal(deletion.result, "checkpoint_then_allow");
  assert.equal(deletion.effects[0]?.entryPath, canonicalLinkEntry);
  assert.equal(deletion.effects[0]?.resolvedPath, canonicalTarget);
  assert.equal(deletion.effects[0]?.state, "tracked_dirty");

  const secretRead = evaluator.evaluate([{ kind: "read", path: secretLink }], states);
  assert.equal(secretRead.result, "ask", "a secret-shaped symlink entry remains protected");
  assert.equal(secretRead.effects[0]?.entryPath, join(canonicalRoot, ".env"));
});
