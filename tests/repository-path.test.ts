import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryObservationError } from "../packages/core/src/domain/errors.ts";
import {
  canonicalRepositoryRoot,
  repositoryPathTarget,
  repositoryPathTargets,
  repositoryPathspecs,
} from "../packages/core/src/repository/repository-path.ts";
import { resolveAccessPath } from "../packages/core/src/security/path-boundary.ts";

test("repository paths use one canonical identity across alias roots, relative inputs, and missing targets", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-repository-path-root-"));
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-repository-path-alias-"));
  const aliasRoot = join(aliasParent, "repo");
  const outside = mkdtempSync(join(tmpdir(), "atlr-repository-path-outside-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "existing.ts"), "export const value = 1;\n", "utf8");
  symlinkSync(root, aliasRoot, "dir");

  try {
    const canonicalRoot = realpathSync.native(root);
    assert.equal(canonicalRepositoryRoot(aliasRoot), canonicalRoot);

    const existingAlias = join(aliasRoot, "src", "existing.ts");
    const existing = repositoryPathTarget(aliasRoot, existingAlias, "read");
    assert.equal(existing.key, existingAlias);
    assert.equal(existing.absolute, realpathSync.native(join(root, "src", "existing.ts")));
    assert.equal(existing.entry, join(canonicalRoot, "src", "existing.ts"));
    assert.equal(existing.relative, "src/existing.ts");

    const missingAlias = join(aliasRoot, "src", "new.ts");
    const missing = repositoryPathTarget(aliasRoot, missingAlias, "write");
    assert.equal(missing.key, missingAlias);
    assert.equal(missing.absolute, join(canonicalRoot, "src", "new.ts"));
    assert.equal(missing.entry, join(canonicalRoot, "src", "new.ts"));
    assert.equal(missing.relative, "src/new.ts");

    const originalCwd = process.cwd();
    process.chdir(outside);
    try {
      const relative = repositoryPathTarget(aliasRoot, "src/new.ts", "write");
      assert.equal(relative.key, join(canonicalRoot, "src", "new.ts"));
      assert.equal(relative.absolute, join(canonicalRoot, "src", "new.ts"));
      assert.equal(relative.relative, "src/new.ts");
    } finally {
      process.chdir(originalCwd);
    }

    const targetFile = join(root, "src", "target.ts");
    const trackedLink = join(root, "src", "tracked-link");
    writeFileSync(targetFile, "export const target = true;\n", "utf8");
    symlinkSync("target.ts", trackedLink);
    const link = repositoryPathTarget(aliasRoot, join(aliasRoot, "src", "tracked-link"), "write");
    assert.equal(link.entry, join(canonicalRoot, "src", "tracked-link"));
    assert.equal(link.absolute, realpathSync.native(targetFile));
    assert.equal(link.relative, "src/tracked-link", "VCS identity preserves the final symlink entry");

    const targets = repositoryPathTargets(aliasRoot, [existingAlias, join(canonicalRoot, "src", "existing.ts")], "read");
    assert.equal(targets.length, 2, "caller spellings remain distinct lookup keys");
    assert.deepEqual(repositoryPathspecs(aliasRoot, targets.map((target) => target.key), "read"), ["src/existing.ts"]);

    assert.throws(
      () => repositoryPathTarget(aliasRoot, join(outside, "escaped.ts"), "write"),
      (error: unknown) => error instanceof RepositoryObservationError && /outside the worktree/.test(error.message),
    );
  } finally {
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing descendants of an in-workspace alias canonicalize through the nearest existing ancestor", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-path-boundary-root-"));
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-path-boundary-alias-"));
  const aliasRoot = join(aliasParent, "repo");
  mkdirSync(join(root, "nested"), { recursive: true });
  symlinkSync(root, aliasRoot, "dir");
  try {
    assert.equal(
      resolveAccessPath(join(aliasRoot, "nested", "not-created", "file.ts"), "write"),
      join(realpathSync.native(root), "nested", "not-created", "file.ts"),
    );
  } finally {
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
