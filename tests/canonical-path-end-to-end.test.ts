import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtelierCore } from "../packages/core/src/core.ts";
import { createTemporaryRepository } from "./fixtures.ts";

test("Core observation and workspace authorization share canonical path identity through a repository alias", { skip: process.platform === "win32" }, async () => {
  const root = createTemporaryRepository("atlr-canonical-end-to-end-");
  const aliasParent = mkdtempSync(join(tmpdir(), "atlr-canonical-end-to-end-alias-"));
  const aliasRoot = join(aliasParent, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  symlinkSync(root, aliasRoot, "dir");

  const core = AtelierCore.open(aliasRoot, { taskProvider: "memory" });
  try {
    const aliasPath = join(aliasRoot, "src", "created.ts");
    const canonicalPath = join(realpathSync.native(root), "src", "created.ts");
    const observation = await core.observeRepository({
      force: true,
      paths: [aliasPath, "src/created.ts"],
      operation: "canonical-path-regression",
    });

    assert.equal(core.config.repositoryRoot, realpathSync.native(root));
    assert.equal(core.config.workspaceRoot, realpathSync.native(root));
    assert.equal(observation.pathStates[aliasPath], "missing");
    assert.equal(observation.pathStates[canonicalPath], "missing");

    const evaluated = await core.evaluateWorkspaceEffectsAsync(
      [{ kind: "create", path: aliasPath, description: "create through alias" }],
      { observation, operation: "canonical-path-regression" },
    );
    assert.equal(evaluated.decision.result, "allow");
    assert.equal(evaluated.decision.effects[0]?.resolvedPath, canonicalPath);
    assert.equal(evaluated.decision.effects[0]?.state, "missing");

    writeFileSync(aliasPath, "export const created = true;\n", "utf8");
    core.invalidateRepositoryObservation();
    const refreshed = await core.observeRepository({ force: true, paths: [aliasPath] });
    assert.equal(refreshed.pathStates[aliasPath], "untracked");
    assert.equal(refreshed.pathStates[canonicalPath], "untracked");
  } finally {
    await core.close();
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
