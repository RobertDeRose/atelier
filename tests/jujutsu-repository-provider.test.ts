import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { JujutsuRepositoryProvider } from "../packages/core/src/repository/jujutsu-repository-provider.ts";
import { sha256 } from "../packages/core/src/util/hash.ts";
import { RepositoryObservationError } from "../packages/core/src/domain/errors.ts";

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
    assert.equal(snapshot.workspaceId, sha256(root).slice(0, 16));
    assert.deepEqual(provider.changedPaths(), ["src/main.ts"]);
    assert.deepEqual(provider.listFiles(), ["README.md", "src/main.ts"]);
    assert.match(provider.diff(), /diff --git/);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Jujutsu observation failures never masquerade as an empty diff", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-jj-failure-"));
  mkdirSync(join(root, ".atelier"), { recursive: true });
  const executable = join(root, "jj-failure");
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("jj 0.30.0"); process.exit(0); }
if (args[0] === "root") { console.log(${JSON.stringify('/placeholder')}); process.exit(0); }
console.error("observation failed");
process.exit(2);
`, "utf8");
  chmodSync(executable, 0o755);
  const ledger = new SqliteLedger(join(root, ".atelier", "atelier.db"));
  try {
    const provider = new JujutsuRepositoryProvider({ cwd: root, ledger, executable });
    assert.throws(() => provider.changedPaths(), RepositoryObservationError);
    assert.throws(() => provider.listFiles(), RepositoryObservationError);
    assert.throws(() => provider.diff(), RepositoryObservationError);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Jujutsu task commits finalize only explicitly approved source paths", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-jj-scoped-commit-"));
  mkdirSync(join(root, ".atelier"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(root, ".atelier", "PLAN.md"), "# reviewed plan\n", "utf8");
  const log = join(root, "commands.jsonl");
  const executable = join(root, "jj-scoped");
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("jj 0.43.0"); process.exit(0); }
if (args[0] === "root") { console.log(${JSON.stringify(root)}); process.exit(0); }
if (args[0] === "workspace" && args[1] === "root") { console.log(${JSON.stringify(root)}); process.exit(0); }
if (args[0] === "log" && args.includes("@-")) { console.log("parent123"); process.exit(0); }
if (args[0] === "log") { console.log("change123\\ncommit456"); process.exit(0); }
if (args[0] === "op" && args[1] === "log") { console.log("operation789"); process.exit(0); }
if (args[0] === "diff" && args.includes("--name-only")) { console.log(".atelier/PLAN.md\\nsrc/main.ts"); process.exit(0); }
if (args[0] === "diff") { console.log("diff --git a/src/main.ts b/src/main.ts"); process.exit(0); }
if (args[0] === "commit") process.exit(0);
process.exit(1);
`, "utf8");
  chmodSync(executable, 0o755);
  const ledger = new SqliteLedger(join(root, ".atelier", "atelier.db"));
  try {
    const provider = new JujutsuRepositoryProvider({ cwd: root, ledger, executable });
    const result = provider.commit("test: scoped task", ["src/main.ts"]);
    assert.deepEqual(result.changedPaths, ["src/main.ts"]);
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(commands.some((args) => args.join("\0") === ["commit", "-m", "test: scoped task", "--", "src/main.ts"].join("\0")));
    assert.equal(commands.some((args) => args[0] === "describe" || args[0] === "new"), false);
    assert.equal(commands.some((args) => args[0] === "commit" && args.includes(".atelier/PLAN.md")), false);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
