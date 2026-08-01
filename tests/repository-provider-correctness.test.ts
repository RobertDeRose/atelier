import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryObservationError } from "../packages/core/src/domain/errors.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { GitRepositoryProvider } from "../packages/core/src/repository/git-repository-provider.ts";
import { createTemporaryRepository, testDatabasePath } from "./fixtures.ts";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
}

test("Git observations include staged and untracked source changes", () => {
  const root = createTemporaryRepository("atlr-git-observation-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    git(root, "add", ".atelier/config.json");
    git(root, "-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "-m", "test: record generated config");
    const baseline = provider.snapshot();
    const cleanDisplay = provider.displayState();
    assert.equal(cleanDisplay.vcs, "git");
    assert.equal(cleanDisplay.state, "clean");
    assert.ok(cleanDisplay.label || cleanDisplay.revision);
    writeFileSync(join(root, "README.md"), "# staged source change\n", "utf8");
    git(root, "add", "README.md");
    writeFileSync(join(root, "new-source.ts"), "export const added = true;\n", "utf8");

    assert.deepEqual(provider.changedPaths(), ["README.md", "new-source.ts"]);
    assert.match(provider.diff(), /# Staged changes/);
    assert.match(provider.diff(), /staged source change/);
    assert.deepEqual(provider.changedPathsFrom(baseline.headCommit), ["README.md", "new-source.ts"]);
    const diff = provider.diffFrom(baseline.headCommit);
    assert.match(diff, /README\.md/);
    assert.match(diff, /new-source\.ts/);
    assert.equal(provider.displayState().state, "dirty");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atelier Git commits do not depend on workstation signing agents", () => {
  const root = createTemporaryRepository("atlr-git-signing-isolation-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    // Reproduce the common macOS setup where global or local Git configuration
    // requires SSH-backed signing but Atelier deliberately does not inherit the
    // SSH agent socket.
    git(root, "config", "commit.gpgSign", "true");
    git(root, "config", "gpg.format", "ssh");
    git(root, "config", "user.signingKey", "key::not-a-real-signing-key");

    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    writeFileSync(join(root, "signed-source.ts"), "export const unsignedByAtelier = true;\n", "utf8");
    const committed = provider.commit("test: commit without signing agent", ["signed-source.ts"]);

    assert.deepEqual(committed.changedPaths, ["signed-source.ts"]);
    const metadata = provider.commitMetadata("test: commit metadata without signing agent", [".atelier/config.json"]);
    assert.deepEqual(metadata.changedPaths, [".atelier/config.json"]);

    const subjects = spawnSync("git", ["log", "-2", "--format=%s"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(subjects.status, 0, subjects.stderr);
    assert.deepEqual(subjects.stdout.trim().split("\n"), [
      "test: commit metadata without signing agent",
      "test: commit without signing agent",
    ]);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git observation failures never masquerade as a clean repository", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-git-not-repository-"));
  const ledger = new SqliteLedger(join(root, "runtime.db"));
  try {
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    assert.equal(provider.status().repository, false);
    for (const observe of [
      () => provider.snapshot(),
      () => provider.changedPaths(),
      () => provider.listFiles(),
      () => provider.diff(),
    ]) {
      assert.throws(observe, RepositoryObservationError);
    }
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git path inventories canonicalize symlinked and macOS-style alias roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink creation is not reliably available without elevated Windows privileges");
    return;
  }

  const root = createTemporaryRepository("atlr-git-canonical-path-");
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-git-path-alias-"));
  const aliasRoot = join(aliasParent, "repo-alias");
  symlinkSync(root, aliasRoot, "dir");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const provider = new GitRepositoryProvider({ cwd: aliasRoot, ledger });
    const aliasPlan = join(aliasRoot, ".atelier", "PLAN.md");
    writeFileSync(aliasPlan, "# Alias plan\n", "utf8");

    const relativeMissing = ".atelier/not-created.md";
    const canonicalMissing = join(realpathSync.native(root), relativeMissing);
    const observation = await provider.observe({ paths: [aliasPlan, relativeMissing] });
    assert.equal(observation.root, realpathSync.native(root));
    assert.equal(observation.pathStates[aliasPlan], "untracked");
    assert.equal(observation.pathStates[realpathSync.native(aliasPlan)], "untracked");
    assert.equal(observation.pathStates[canonicalMissing], "missing");
    assert.equal(provider.classifyPath(relativeMissing), "missing");
    const recovery = provider.captureRecoveryState([aliasPlan, relativeMissing]);
    assert.equal(recovery.native?.root, realpathSync.native(root));
    assert.deepEqual(recovery.native?.relativePaths, [".atelier/PLAN.md", relativeMissing]);
    assert.equal(observation.displayState.state, "dirty");
  } finally {
    ledger.close();
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidating a Git observation prevents an older in-flight result from replacing fresh state", async () => {
  const root = createTemporaryRepository("atlr-git-observation-generation-");
  git(root, "add", ".atelier/config.json");
  git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "test: establish clean observation baseline");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    const mutable = provider as unknown as {
      observeFresh(options: Record<string, unknown>): Promise<Awaited<ReturnType<GitRepositoryProvider["observe"]>>>;
    };
    const original = mutable.observeFresh.bind(provider);
    let releaseFirst!: () => void;
    let capturedFirst!: () => void;
    const firstCaptured = new Promise<void>((resolve) => { capturedFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    mutable.observeFresh = async (options) => {
      calls += 1;
      const observation = await original(options);
      if (calls === 1) {
        capturedFirst();
        await release;
      }
      return observation;
    };

    const stalePending = provider.observe({ force: true });
    await firstCaptured;
    provider.invalidateObservation();
    writeFileSync(join(root, "README.md"), "# changed after invalidation\n", "utf8");

    const fresh = await provider.observe({ force: true });
    assert.equal(fresh.displayState.state, "dirty");
    releaseFirst();
    const stale = await stalePending;
    assert.equal(stale.displayState.state, "clean");
    assert.equal(provider.peekObservation()?.displayState.state, "dirty",
      "an observation started before invalidation must not overwrite the newer cache entry");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
