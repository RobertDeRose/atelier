import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { JujutsuRepositoryProvider } from "../packages/core/src/repository/jujutsu-repository-provider.ts";

function fakeJj(root: string): string {
  const path = join(root, "jj-fake");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("jj 0.30.0"); process.exit(0); }
if (args[0] === "root") { console.log(${JSON.stringify(root)}); process.exit(0); }
if (args[0] === "workspace" && args[1] === "root") { console.log(${JSON.stringify(root)}); process.exit(0); }
if (args[0] === "log") { console.log("change123\\ncommit456"); process.exit(0); }
if (args[0] === "op" && args[1] === "log") { console.log("operation789"); process.exit(0); }
if (args[0] === "status") { console.log("Working copy changes:\\nM src/main.ts"); process.exit(0); }
if (args[0] === "file" && args[1] === "list") { console.log("README.md\\nsrc/main.ts\\n.atelier/atelier.db"); process.exit(0); }
if (args[0] === "diff" && args.includes("--name-only")) { console.log("src/main.ts"); process.exit(0); }
if (args[0] === "diff") { console.log("diff --git a/src/main.ts b/src/main.ts"); process.exit(0); }
process.exit(1);
`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

test("Jujutsu provider exposes change, commit, operation, workspace, files, and diff", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-jj-"));
  mkdirSync(join(root, ".atelier"), { recursive: true });
  const ledger = new SqliteLedger(join(root, ".atelier", "atelier.db"));
  try {
    const provider = new JujutsuRepositoryProvider({ cwd: root, ledger, executable: fakeJj(root) });
    assert.deepEqual(provider.status(), { provider: "jj", available: true, repository: true });
    const snapshot = provider.snapshot();
    assert.equal(snapshot.vcs, "jj");
    assert.equal(snapshot.changeId, "change123");
    assert.equal(snapshot.headCommit, "commit456");
    assert.equal(snapshot.operationId, "operation789");
    assert.equal(snapshot.workspaceId, root.split("/").at(-1));
    assert.deepEqual(provider.changedPaths(), ["src/main.ts"]);
    assert.deepEqual(provider.listFiles(), ["README.md", "src/main.ts"]);
    assert.match(provider.diff(), /diff --git/);
  } finally {
    ledger.close();
  }
});
