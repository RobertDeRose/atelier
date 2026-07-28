import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AtelierCore,
  PolicyEngine,
  classifyShellCommand,
  isPathWithin,
  loadConfig,
  projectTrustStatus,
  type ActionRequest,
  type ExecutionGrant,
  type PermissionGrant,
  SqliteLedger,
} from "../packages/core/src/index.ts";
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

test("untrusted project configuration cannot execute providers or redirect runtime state", async () => {
  const root = createUntrustedRepository("atlr-untrusted-open-");
  const marker = join(root, "provider-executed");
  const executable = join(root, "malicious-provider.mjs");
  writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`, "utf8");
  chmodSync(executable, 0o755);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    repositoryProvider: "jj",
    jjCommand: executable,
    taskProvider: "beads",
    beadsCommand: executable,
    codeProvider: "codesearch",
    codeCommand: executable,
    runtimeDirectory: join(root, ".atelier", "runtime-escape"),
    databasePath: join(root, ".atelier", "project-owned.db"),
  }), "utf8");

  try {
    const config = loadConfig(root);
    assert.equal(config.projectTrusted, false);
    assert.notEqual(config.jjCommand, executable);
    assert.notEqual(config.beadsCommand, executable);
    assert.notEqual(config.codeCommand, executable);
    assert.equal(isPathWithin(config.runtimeDirectory, root, "write"), false);
    assert.equal(isPathWithin(config.databasePath, root, "write"), false);

    const core = AtelierCore.open(root);
    try {
      assert.equal(core.repository.name, "none");
      assert.equal((await core.taskProvider.status()).provider, "none");
      assert.equal(existsSync(marker), false);
    } finally {
      await core.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("doctor is observational and does not open repository-controlled providers or create project state", () => {
  const root = createUntrustedRepository("atlr-doctor-observational-");
  const marker = join(root, "doctor-provider-executed");
  const executable = join(root, "doctor-provider.mjs");
  writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`, "utf8");
  chmodSync(executable, 0o755);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({ repositoryProvider: "jj", jjCommand: executable }), "utf8");
  const runtime = loadConfig(root).runtimeDirectory;

  try {
    assert.equal(existsSync(runtime), false);
    const result = runCli(root, ["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { observational: boolean; trust: { trusted: boolean }; configuredProviders: Record<string, string> };
    assert.equal(report.observational, true);
    assert.equal(report.trust.trusted, false);
    assert.deepEqual(report.configuredProviders, { repository: "disabled", tasks: "disabled", code: "disabled" });
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, ".atelier", "atelier.db")), false);
    assert.equal(existsSync(runtime), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real-path confinement rejects existing and not-yet-created targets below an escaping symlink", () => {
  const root = createTemporaryRepository("atlr-symlink-boundary-");
  const outside = mkdtempSync(join(tmpdir(), "atlr-symlink-outside-"));
  const linked = join(root, "linked");
  writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");
  symlinkSync(outside, linked, "dir");

  const snapshot = {
    repositoryId: "repository",
    workspaceId: "workspace",
    vcs: "git" as const,
    headCommit: "head",
    dirtyGeneration: 0,
    dirtyFingerprint: "clean",
    indexSchemaVersion: 1,
  };
  const executionGrant: ExecutionGrant = {
    id: "execution",
    status: "active",
    planApprovalId: "approval",
    reconciliationTransactionId: "transaction",
    planHash: "plan",
    reconciliationDigest: "reconciliation",
    provider: { name: "memory", version: "1" },
    workspaceId: snapshot.workspaceId,
    repositoryId: snapshot.repositoryId,
    repositorySnapshot: snapshot,
    repositoryBindings: [],
    retrievalBindings: [],
    capabilityDigest: "capabilities",
    taskId: "task",
    planTaskId: "ATLR-001",
    issuedAt: new Date().toISOString(),
  };
  const grant: PermissionGrant = {
    id: "grant",
    executionGrantId: executionGrant.id,
    permission: "file.write",
    scope: "task",
    actor: "user",
    taskId: executionGrant.taskId,
    repositoryId: executionGrant.repositoryId,
    paths: [root],
    reason: "typed writes only",
    createdAt: new Date().toISOString(),
  };
  const request = (path: string): ActionRequest => ({
    action: "write.file",
    risk: "routine",
    actor: "agent",
    taskId: executionGrant.taskId,
    repositorySnapshot: snapshot,
    paths: [path],
    boundary: "typed",
    rationale: "boundary regression",
  });

  try {
    assert.equal(isPathWithin(join(linked, "secret.txt"), root, "read"), false);
    assert.equal(isPathWithin(join(linked, "new.txt"), root, "write"), false);
    const policy = new PolicyEngine();
    for (const path of [join(linked, "secret.txt"), join(linked, "new.txt")]) {
      assert.equal(policy.evaluate(request(path), {
        mode: "act",
        projectTrusted: true,
        repositoryRoot: root,
        planPath: join(root, ".atelier", "PLAN.md"),
        grants: [grant],
        executionGrant,
      }).result, "require_approval");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project trust records remain external and validation manifests reject executable approval metadata", async () => {
  const root = createTemporaryRepository("atlr-trust-manifest-");
  try {
    const trust = projectTrustStatus(root);
    assert.equal(trust.trusted, true);
    assert.equal(resolve(trust.storePath).startsWith(`${resolve(root)}/`), false);
    assert.equal(dirname(trust.storePath) === resolve(root), false);

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
    rmSync(root, { recursive: true, force: true });
  }
});


test("legacy turn and session grants are revoked by the scope migration", () => {
  const root = createTemporaryRepository("atlr-legacy-grant-scopes-");
  const databasePath = testDatabasePath(root);
  let ledger = new SqliteLedger(databasePath);
  try {
    ledger.database.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
    ledger.database.prepare(`
      INSERT INTO permission_grants(
        id, execution_grant_id, permission, scope, actor, task_id, repository_id, paths_json,
        command_prefix_json, reason, created_at, expires_at, revoked_at
      ) VALUES (?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run("legacy-session", "command.execute", "session", "user", "legacy unsupported scope", new Date().toISOString());
    ledger.close();

    ledger = new SqliteLedger(databasePath);
    assert.equal(ledger.listGrants().some((grant) => grant.id === "legacy-session"), false);
    const migrated = ledger.listGrants({ includeRevoked: true }).find((grant) => grant.id === "legacy-session");
    assert.ok(migrated?.revokedAt);
    const versions = ledger.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
