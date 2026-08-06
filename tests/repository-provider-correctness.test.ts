import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryObservationError } from "../packages/core/src/domain/errors.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { GitRepositoryProvider } from "../packages/core/src/repository/git-repository-provider.ts";
import { MAX_REPOSITORY_HASH_BYTES } from "../packages/core/src/repository/repository-content.ts";
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

test("Git snapshots reuse async observations and share source identity", async () => {
  const root = createTemporaryRepository("atlr-git-snapshot-identity-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    const observed = await provider.observe();
    assert.equal(provider.snapshot().sourceFingerprint, observed.snapshot.sourceFingerprint);
    writeFileSync(join(root, "README.md"), "changed source\n", "utf8");
    const changed = await provider.observe({ force: true });
    assert.equal(provider.snapshot().sourceFingerprint, changed.snapshot.sourceFingerprint);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git observation does not read outside, broken, or oversized tracked symlink targets", async (t) => {
  if (process.platform === "win32") {
    t.skip("file symlink creation is not reliably available without elevated Windows privileges");
    return;
  }
  const root = createTemporaryRepository("atlr-git-symlink-observation-");
  const external = mkdtempSync(join(tmpdir(), "atlr-git-symlink-targets-"));
  const secret = join(external, "secret.txt");
  const oversized = join(external, "oversized.bin");
  const links = ["outside-secret.ts", "broken-target.ts", "oversized-target.ts"];
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    writeFileSync(secret, "external secret contents\n", "utf8");
    writeFileSync(oversized, "", "utf8");
    truncateSync(oversized, MAX_REPOSITORY_HASH_BYTES + 1);
    for (const path of links) symlinkSync("initial-target", join(root, path), "file");
    git(root, "add", ".atelier/config.json", ...links);
    git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "test: establish symlink baseline");

    rmSync(join(root, links[0]!));
    symlinkSync(secret, join(root, links[0]!), "file");
    rmSync(join(root, links[1]!));
    symlinkSync("missing-target", join(root, links[1]!), "file");
    rmSync(join(root, links[2]!));
    symlinkSync(oversized, join(root, links[2]!), "file");

    const observation = await new GitRepositoryProvider({ cwd: root, ledger }).observe({ force: true });
    assert.deepEqual(observation.changedPaths, [...links].sort());
    assert.equal(observation.metrics.filesHashed, 0);
    assert.equal(observation.metrics.bytesHashed, 0);
  } finally {
    ledger.close();
    rmSync(external, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atelier Git commits preserve signing policy and report signing failures", () => {
  const root = createTemporaryRepository("atlr-git-signing-isolation-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    // Reproduce the common macOS setup where global or local Git configuration
    // requires SSH-backed signing. A bad signer must fail rather than be
    // silently bypassed; repository policy can then explicitly disable signing.
    git(root, "config", "commit.gpgSign", "true");
    git(root, "config", "gpg.format", "ssh");
    git(root, "config", "user.signingKey", "key::not-a-real-signing-key");

    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    writeFileSync(join(root, "signed-source.ts"), "export const unsignedByAtelier = true;\n", "utf8");
    assert.throws(
      () => provider.commit("test: signed commit failure", ["signed-source.ts"]),
      /sign|key|commit/i,
      "a configured signing failure must not be bypassed",
    );
    git(root, "reset", "--", "signed-source.ts");
    git(root, "config", "commit.gpgSign", "false");
    const committed = provider.commit("test: commit with signing disabled by repository policy", ["signed-source.ts"]);

    assert.deepEqual(committed.changedPaths, ["signed-source.ts"]);
    const metadata = provider.commitMetadata("test: commit metadata with repository policy", [".atelier/config.json"]);
    assert.deepEqual(metadata.changedPaths, [".atelier/config.json"]);

    const subjects = spawnSync("git", ["log", "-2", "--format=%s"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(subjects.status, 0, subjects.stderr);
    assert.deepEqual(subjects.stdout.trim().split("\n"), [
      "test: commit metadata with repository policy",
      "test: commit with signing disabled by repository policy",
    ]);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Atelier Git commits honor repository hooks and clean-smudge filters", () => {
  const root = createTemporaryRepository("atlr-git-hook-filter-isolation-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  const filterMarker = join(root, "filter-ran");
  const hookMarker = join(root, "hook-ran");
  const signingMarker = join(root, "signing-env");
  const previousSigningSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  try {
    writeFileSync(join(root, ".gitattributes"), "# baseline attributes\n", "utf8");
    git(root, "add", ".gitattributes");
    git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "test: establish attributes baseline");

    const filter = join(root, "external-filter.sh");
    writeFileSync(filter, `#!/bin/sh\nprintf filtered > ${JSON.stringify(filterMarker)}\ncat\n`, "utf8");
    chmodSync(filter, 0o755);
    git(root, "config", "filter.atelier.clean", filter);
    git(root, "config", "filter.atelier.smudge", filter);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=atelier\n", "utf8");
    writeFileSync(join(root, "source.txt"), "raw source contents\n", "utf8");

    const hook = join(root, ".git", "hooks", "pre-commit");
    git(root, "config", "core.hooksPath", ".git/hooks");
    writeFileSync(hook, `#!/bin/sh\nprintf hooked > ${JSON.stringify(hookMarker)}\nprintf %s "$SSH_AUTH_SOCK" > ${JSON.stringify(signingMarker)}\nexit 1\n`, "utf8");
    chmodSync(hook, 0o755);

    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    assert.throws(
      () => provider.commit("test: hook rejection remains visible", [".gitattributes", "source.txt"]),
      /hook|failed|exit/i,
    );
    assert.equal(existsSync(filterMarker), true, "configured clean filter must run during staging");
    assert.equal(existsSync(hookMarker), true, "configured pre-commit hook must run");
    assert.equal(readFileSync(signingMarker, "utf8"), process.env.SSH_AUTH_SOCK);
    rmSync(hook, { force: true });
    provider.commit("test: commit with repository hook and filter", [".gitattributes", "source.txt"]);

    assert.equal(existsSync(filterMarker), true, "clean/smudge filter must remain active");
    const committed = spawnSync("git", ["show", "HEAD:source.txt"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(committed.stdout, "raw source contents\n");
  } finally {
    if (previousSigningSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSigningSocket;
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git scoped commits preserve unrelated staged changes", () => {
  const root = createTemporaryRepository("atlr-git-scoped-staging-");
  const ledger = new SqliteLedger(testDatabasePath(root));
  try {
    writeFileSync(join(root, "unrelated.ts"), "export const unrelated = true;\n", "utf8");
    git(root, "add", "unrelated.ts");
    writeFileSync(join(root, "scoped.ts"), "export const scoped = true;\n", "utf8");
    const provider = new GitRepositoryProvider({ cwd: root, ledger });
    provider.commit("test: commit only scoped path", ["scoped.ts"]);

    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(staged.status, 0, staged.stderr);
    assert.deepEqual(staged.stdout.trim().split("\n"), ["unrelated.ts"]);
    assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:unrelated.ts"], { cwd: root, encoding: "utf8", shell: false }).status, 128);
    assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:scoped.ts"], { cwd: root, encoding: "utf8", shell: false }).status, 0);
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
