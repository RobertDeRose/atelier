import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
