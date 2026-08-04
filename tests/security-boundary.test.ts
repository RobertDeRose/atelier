import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AtelierCore,
  classifyShellCommand,
  isPathWithin,
  loadConfig,
  SqliteLedger,
  WorkspacePolicyEvaluator,
} from "../packages/core/src/index.ts";
import { requestForTool } from "../apps/pi-extension/src/tool-authorization.ts";
import { effectsForShellCommand } from "../apps/pi-extension/src/tool-effects.ts";
import { createTemporaryRepository, testDatabasePath } from "./fixtures.ts";

function createUntrustedRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".atelier"), { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", shell: false });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "Unable to create untrusted Git fixture");
  return root;
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    join(process.cwd(), "apps", "cli", "src", "main.ts"),
    "--root", root,
    ...args,
  ], { encoding: "utf8", shell: false });
}

test("adversarial shell forms never inherit repository-read authorization", () => {
  const commands = [
    "env rm -rf build",
    "env curl https://example.com",
    "sed --in-place s/a/b/ src/file.ts",
    "git branch new-feature",
    "git tag v1.0.0",
    "jj file untrack secret.txt",
    "cat <(rm -rf build)",
    "fd -x rm {}",
    "rg --pre \"touch /tmp/pwned\" needle",
    "sort -o output input",
    "find . -exec env rm {} \\;",
  ];

  for (const command of commands) {
    const result = classifyShellCommand(command);
    assert.notEqual(
      result.action === "read.repository" && result.mutating === false && result.risk === "routine",
      true,
      `${command} was incorrectly authorized as a routine repository read`,
    );
  }
});

test("Git diff output options produce guarded concrete file effects", async () => {
  const root = createTemporaryRepository("atlr-git-diff-output-boundary-");
  writeFileSync(join(root, ".atelier", "PLAN.md"), "# reviewed plan\n", "utf8");
  writeFileSync(join(root, "unapproved.txt"), "existing output\n", "utf8");
  const core = AtelierCore.open(root, { taskProvider: "none" });
  const ctx = { cwd: root } as any;
  try {
    for (const [command, expectedPath] of [
      ["git diff --output=.atelier/PLAN.md", join(root, ".atelier", "PLAN.md")],
      ["git diff -o unapproved.txt", join(root, "unapproved.txt")],
    ] as const) {
      const effects = effectsForShellCommand(command, root, false);
      assert.equal(effects.length, 1, command);
      assert.equal(effects[0]?.path, expectedPath, command);
      assert.notEqual(effects[0]?.kind, "read", command);
      const request = requestForTool({ toolName: "bash", input: { command } }, ctx, core, effects);
      assert.equal(request.action, "command.execute", command);
      assert.equal(core.evaluateWorkflow(request).result, "deny", command);
    }
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the authoritative Pi effect and workflow path fail closed for adversarial shell forms", async () => {
  const root = createTemporaryRepository("atlr-authoritative-shell-boundary-");
  const core = AtelierCore.open(root, { taskProvider: "none" });
  const ctx = { cwd: root } as any;
  const commands = [
    "git branch new-feature",
    "git branch -D old",
    "jj workspace forget old-workspace",
    "jj op restore abc123",
    "rg --pre \"touch /tmp/pwned\" needle",
    "cat ~/.ssh/id_rsa",
  ];
  try {
    for (const command of commands) {
      const effects = effectsForShellCommand(command, root, false);
      assert.equal(
        effects.every((effect) => effect.kind === "read"),
        false,
        `${command} produced only read effects`,
      );
      const workspace = core.evaluateWorkspaceEffects(effects);
      assert.equal(workspace.result, "ask", `${command}: ${workspace.reason}`);
      const request = requestForTool({ toolName: "bash", input: { command } }, ctx, core, effects);
      assert.notEqual(request.action, "read.repository", command);
      assert.equal(core.evaluateWorkflow(request).result, "deny", `${command} mutated from investigate mode`);
    }
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository configuration cannot select executable commands", () => {
  const root = createUntrustedRepository("atlr-repository-executable-config-");
  const marker = join(root, "repository-command-ran");
  const command = join(root, "malicious-jj");
  writeFileSync(command, `#!/bin/sh\nprintf executed >${JSON.stringify(marker)}\nexit 1\n`, "utf8");
  chmodSync(command, 0o755);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    repositoryProvider: "auto",
    taskProvider: "none",
    codeProvider: "disabled",
    jjCommand: command,
  }), "utf8");
  try {
    assert.throws(() => AtelierCore.open(root, { taskProvider: "none" }), /cannot select executable commands.*jjCommand/i);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup workspace requires no Atelier trust and runtime state remains external", async () => {
  const root = createUntrustedRepository("atlr-workspace-open-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    repositoryProvider: "git", taskProvider: "none", codeProvider: "disabled",
    runtimeDirectory: join(root, ".atelier", "runtime-escape"),
    databasePath: join(root, ".atelier", "project-owned.db"),
  }), "utf8");
  try {
    const config = loadConfig(root);
    assert.equal(config.workspaceRoot, realpathSync.native(root));
    assert.equal(isPathWithin(config.runtimeDirectory, root, "write"), false);
    assert.equal(isPathWithin(config.databasePath, root, "write"), false);
    const core = AtelierCore.open(root, { taskProvider: "none" });
    try { assert.equal(core.repository.name, "git"); } finally { await core.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("user-level runtime configuration cannot move mutable state into the project", () => {
  const root = createTemporaryRepository("atlr-external-runtime-");
  const previousStateHome = process.env.ATLR_STATE_HOME;
  try {
    process.env.ATLR_STATE_HOME = join(root, ".atelier", "runtime");
    assert.throws(() => loadConfig(root), /runtimeDirectory must remain outside the project root/i);
  } finally {
    if (previousStateHome === undefined) delete process.env.ATLR_STATE_HOME;
    else process.env.ATLR_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor is observational and reports the automatic workspace without creating runtime state", () => {
  const root = createUntrustedRepository("atlr-doctor-observational-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({ repositoryProvider: "git", taskProvider: "none", codeProvider: "disabled" }), "utf8");
  const runtime = loadConfig(root).runtimeDirectory;
  try {
    assert.equal(existsSync(runtime), false);
    const result = runCli(root, ["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { observational: boolean; workspace: { root: string; policy: string }; configuredProviders: Record<string, string> };
    assert.equal(report.observational, true);
    assert.equal(report.workspace.root, realpathSync.native(root));
    assert.equal(report.workspace.policy, "workspace_recoverability");
    assert.deepEqual(report.configuredProviders, { repository: "git", tasks: "none", code: "disabled" });
    assert.equal(existsSync(runtime), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real-path confinement rejects existing and not-yet-created targets below an escaping symlink", () => {
  const root = createTemporaryRepository("atlr-symlink-boundary-");
  const outside = mkdtempSync(join(tmpdir(), "atlr-symlink-outside-"));
  const linked = join(root, "linked");
  writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");
  symlinkSync(outside, linked, "dir");
  try {
    assert.equal(isPathWithin(join(linked, "secret.txt"), root, "read"), false);
    assert.equal(isPathWithin(join(linked, "new.txt"), root, "write"), false);
    const policy = new WorkspacePolicyEvaluator({ root });
    const resolver = { classify: () => "missing" as const };
    for (const path of [join(linked, "secret.txt"), join(linked, "new.txt")]) {
      const decision = policy.evaluate([{ kind: "create", path }], resolver);
      assert.equal(decision.result, "ask");
      assert.equal(decision.effects[0]?.state, "outside_workspace");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("legacy Atelier trust state is ignored and validation manifests reject executable approval metadata", async () => {
  const root = createTemporaryRepository("atlr-legacy-trust-manifest-");
  const previousTrustStore = process.env.ATLR_TRUST_STORE;
  const obsoleteStore = join(root, "obsolete-trust.json");
  process.env.ATLR_TRUST_STORE = obsoleteStore;
  writeFileSync(obsoleteStore, JSON.stringify({ version: 1, projects: { obsolete: { root: "/outside" } } }), "utf8");
  try {
    const config = loadConfig(root);
    assert.equal(config.workspaceRoot, realpathSync.native(root));

    writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({
      validations: {
        check: {
          command: [process.execPath, "-e", "process.exit(0)"],
          category: "focused",
          focused: true,
          required: true,
          approval: "never",
        },
      },
    }), "utf8");
    const core = AtelierCore.open(root, { taskProvider: "memory" });
    try {
      assert.throws(() => core.validation.manifest(), /removed field approval|approval.*not supported|unsupported.*approval/i);
    } finally {
      await core.close();
    }
  } finally {
    if (previousTrustStore === undefined) delete process.env.ATLR_TRUST_STORE;
    else process.env.ATLR_TRUST_STORE = previousTrustStore;
    rmSync(root, { recursive: true, force: true });
  }
});


test("legacy permission storage is deleted rather than reinterpreted", () => {
  const root = createTemporaryRepository("atlr-legacy-permission-storage-");
  const databasePath = testDatabasePath(root);
  let ledger = new SqliteLedger(databasePath);
  try {
    ledger.database.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
    ledger.database.exec(`
      CREATE TABLE permission_grants(
        id TEXT PRIMARY KEY,
        permission TEXT NOT NULL,
        scope TEXT NOT NULL
      );
      INSERT INTO permission_grants(id, permission, scope)
      VALUES ('legacy-session', 'command.execute', 'session');
    `);
    ledger.close();

    ledger = new SqliteLedger(databasePath);
    assert.equal(
      ledger.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'").get(),
      undefined,
    );
    const versions = ledger.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
