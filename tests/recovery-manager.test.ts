import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RecoveryManager } from "../packages/core/src/recovery/recovery-manager.ts";
import { GitRepositoryProvider } from "../packages/core/src/repository/git-repository-provider.ts";
import { JujutsuRepositoryProvider } from "../packages/core/src/repository/jujutsu-repository-provider.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import type { EvaluatedEffect } from "../packages/core/src/policy/workspace-policy.ts";
import { createTemporaryRepository, testDatabasePath } from "./fixtures.ts";

function gitResult(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function checkpointEffect(path: string): EvaluatedEffect {
  return {
    kind: "overwrite",
    path,
    resolvedPath: path,
    destructive: true,
    state: "tracked_dirty",
    decision: "checkpoint_then_allow",
    reason: "test checkpoint",
  };
}

function scopedGitState(root: string, paths: string[]): Record<string, string> {
  return {
    status: gitResult(root, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...paths),
    index: gitResult(root, "ls-files", "--stage", "-z", "--", ...paths),
    flags: gitResult(root, "ls-files", "-v", "-z", "--", ...paths),
    staged: gitResult(root, "diff", "--cached", "--binary", "--", ...paths),
    unstaged: gitResult(root, "diff", "--binary", "--", ...paths),
  };
}

test("Git recovery restores exact staged, unstaged, rename, mode, symlink, ignored, and untracked state", () => {
  const root = createTemporaryRepository("atlr-recovery-git-");
  const runtime = mkdtempSync(join(tmpdir(), "atlr-recovery-runtime-"));
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    writeFileSync(join(root, "partial.txt"), "base-one\nbase-two\n", "utf8");
    writeFileSync(join(root, "mode.sh"), "#!/bin/sh\necho base\n", "utf8");
    writeFileSync(join(root, "old-name.txt"), "rename base\n", "utf8");
    writeFileSync(join(root, "target-a.txt"), "a\n", "utf8");
    writeFileSync(join(root, "target-b.txt"), "b\n", "utf8");
    symlinkSync("target-a.txt", join(root, "tracked-link"));
    gitResult(root, "add", ".gitignore", "partial.txt", "mode.sh", "old-name.txt", "target-a.txt", "target-b.txt", "tracked-link");
    gitResult(root, "commit", "--quiet", "--no-gpg-sign", "-m", "test: recovery baseline");

    // Partially staged contents.
    writeFileSync(join(root, "partial.txt"), "staged-one\nbase-two\n", "utf8");
    gitResult(root, "add", "partial.txt");
    writeFileSync(join(root, "partial.txt"), "staged-one\nunstaged-two\n", "utf8");

    // Staged mode change, staged rename plus unstaged content, and changed symlink.
    chmodSync(join(root, "mode.sh"), 0o755);
    gitResult(root, "add", "mode.sh");
    gitResult(root, "mv", "old-name.txt", "new-name.txt");
    writeFileSync(join(root, "new-name.txt"), "rename base\nunstaged addition\n", "utf8");
    unlinkSync(join(root, "tracked-link"));
    symlinkSync("target-b.txt", join(root, "tracked-link"));

    writeFileSync(join(root, "ignored.txt"), "ignored exact contents\n", "utf8");
    writeFileSync(join(root, "untracked.txt"), "untracked exact contents\n", "utf8");

    const relativePaths = [
      "partial.txt",
      "mode.sh",
      "old-name.txt",
      "new-name.txt",
      "tracked-link",
      "ignored.txt",
      "untracked.txt",
    ];
    const absolutePaths = relativePaths.map((path) => join(root, path));
    const before = scopedGitState(root, relativePaths);
    const beforeContents = {
      partial: readFileSync(join(root, "partial.txt"), "utf8"),
      renamed: readFileSync(join(root, "new-name.txt"), "utf8"),
      ignored: readFileSync(join(root, "ignored.txt"), "utf8"),
      untracked: readFileSync(join(root, "untracked.txt"), "utf8"),
      link: readlinkSync(join(root, "tracked-link")),
      mode: Number(lstatSync(join(root, "mode.sh")).mode) & 0o7777,
    };

    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    const recovery = new RecoveryManager({ workspaceRoot: root, runtimeDirectory: runtime, repository: provider });
    const checkpoint = recovery.checkpoint(absolutePaths.map(checkpointEffect), {
      toolCallId: "git-destructive-call",
      sessionId: "pi-session-exact",
    });
    assert.equal(checkpoint.toolCallId, "git-destructive-call");
    assert.equal(checkpoint.sessionId, "pi-session-exact");

    // Destroy worktree and index state without changing HEAD.
    writeFileSync(join(root, "partial.txt"), "destroyed\n", "utf8");
    chmodSync(join(root, "mode.sh"), 0o600);
    rmSync(join(root, "new-name.txt"), { force: true });
    writeFileSync(join(root, "old-name.txt"), "wrong old path\n", "utf8");
    rmSync(join(root, "tracked-link"), { force: true });
    symlinkSync("target-a.txt", join(root, "tracked-link"));
    rmSync(join(root, "ignored.txt"), { force: true });
    rmSync(join(root, "untracked.txt"), { force: true });
    gitResult(root, "add", "-A");

    recovery.restore(checkpoint.id);

    assert.deepEqual(scopedGitState(root, relativePaths), before);
    assert.equal(readFileSync(join(root, "partial.txt"), "utf8"), beforeContents.partial);
    assert.equal(readFileSync(join(root, "new-name.txt"), "utf8"), beforeContents.renamed);
    assert.equal(readFileSync(join(root, "ignored.txt"), "utf8"), beforeContents.ignored);
    assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), beforeContents.untracked);
    assert.equal(readlinkSync(join(root, "tracked-link")), beforeContents.link);
    assert.equal(Number(lstatSync(join(root, "mode.sh")).mode) & 0o7777, beforeContents.mode);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Recovery restore rejects symlinked manifest parents before deleting outside files", () => {
  const root = createTemporaryRepository("atlr-recovery-restore-boundary-");
  const runtime = mkdtempSync(join(tmpdir(), "atlr-recovery-restore-boundary-runtime-"));
  const outside = mkdtempSync(join(tmpdir(), "atlr-recovery-restore-boundary-outside-"));
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const parent = join(root, "checkpointed");
    const checkpointed = join(parent, "payload.txt");
    const outsideFile = join(outside, "payload.txt");
    mkdirSync(parent);
    writeFileSync(checkpointed, "checkpoint contents\n", "utf8");
    writeFileSync(outsideFile, "outside contents\n", "utf8");

    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    const recovery = new RecoveryManager({ workspaceRoot: root, runtimeDirectory: runtime, repository: provider });
    const checkpoint = recovery.checkpoint([checkpointEffect(checkpointed)]);

    rmSync(parent, { recursive: true, force: true });
    symlinkSync(outside, parent, "dir");

    assert.throws(() => recovery.restore(checkpoint.id), /outside the worktree/);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside contents\n");
  } finally {
    ledger.close();
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Recovery checkpoints preserve broken symlinks and clean up atomically when limits fail", () => {
  const root = createTemporaryRepository("atlr-recovery-limit-");
  const runtime = mkdtempSync(join(tmpdir(), "atlr-recovery-limit-runtime-"));
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const broken = join(root, "broken-link");
    symlinkSync("missing-target", broken);
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    const recovery = new RecoveryManager({ workspaceRoot: root, runtimeDirectory: runtime, repository: provider });
    const checkpoint = recovery.checkpoint([checkpointEffect(broken)]);
    unlinkSync(broken);
    symlinkSync("different-target", broken);
    recovery.restore(checkpoint.id);
    assert.equal(readlinkSync(broken), "missing-target");

    const oversized = join(root, "oversized.bin");
    writeFileSync(oversized, Buffer.alloc(256, 1));
    const limited = new RecoveryManager({ workspaceRoot: root, runtimeDirectory: runtime, repository: provider, maxBytes: 32 });
    assert.throws(() => limited.checkpoint([checkpointEffect(oversized)]), /exceeds 32 bytes/);
    const checkpointRoot = join(runtime, "checkpoints");
    const entries = readdirSync(checkpointRoot).filter((entry) => entry !== checkpoint.id);
    assert.deepEqual(entries, []);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Jujutsu recovery uses the captured operation and verifies the restored working-copy identity", () => {
  const root = createTemporaryRepository("atlr-recovery-jj-");
  const runtime = mkdtempSync(join(tmpdir(), "atlr-recovery-jj-runtime-"));
  const ledger = new SqliteLedger(testDatabasePath(root));
  const logPath = join(runtime, "jj-calls.jsonl");
  const fake = join(runtime, "jj-fake.mjs");
  try {
    writeFileSync(fake, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");\nif (args[0] === "root") console.log(${JSON.stringify(root)});\nelse if (args[0] === "op" && args[1] === "log") console.log("operation-exact");\nelse if (args[0] === "op" && args[1] === "restore") process.exit(args[2] === "operation-exact" ? 0 : 2);\nelse if (args[0] === "workspace" && args[1] === "update-stale") process.exit(0);\nelse if ((args[0] === "log") || args[0]?.startsWith("--at-op=")) console.log("change-exact\\ncommit-exact");\nelse process.exit(0);\n`, "utf8");
    chmodSync(fake, 0o755);
    const path = join(root, "jj-state.txt");
    writeFileSync(path, "before jj restore\n", "utf8");
    const provider = new JujutsuRepositoryProvider({ cwd: root, ledger, executable: fake });
    const recovery = new RecoveryManager({ workspaceRoot: root, runtimeDirectory: runtime, repository: provider });
    const checkpoint = recovery.checkpoint([checkpointEffect(path)], { toolCallId: "jj-call", sessionId: "jj-session" });
    writeFileSync(path, "after destructive jj change\n", "utf8");
    recovery.restore(checkpoint.id);
    assert.equal(readFileSync(path, "utf8"), "before jj restore\n");
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "op" && args[1] === "restore" && args[2] === "operation-exact"));
    assert.ok(calls.some((args) => args[0] === "--at-op=operation-exact"));
    assert.ok(calls.some((args) => args[0] === "workspace" && args[1] === "update-stale"));
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
