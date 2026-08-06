import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import {
  AtelierCore,
  DisabledCodeProvider,
  QualityGatePolicyError,
  QualityGateService,
  qualityGatePlanningInventory,
} from "../packages/core/src/index.ts";
import { GitRepositoryProvider } from "../packages/core/src/repository/git-repository-provider.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";
import { createTemporaryRepository, testDatabasePath, VALID_PLAN } from "./fixtures.ts";

function service(root: string, environment?: NodeJS.ProcessEnv): { gates: QualityGateService; ledger: SqliteLedger } {
  const ledger = new SqliteLedger(testDatabasePath(root));
  const repository = new GitRepositoryProvider({ cwd: root, ledger });
  return {
    gates: new QualityGateService({ root, repository, ...(environment === undefined ? {} : { environment }) }),
    ledger,
  };
}

async function activeQualityCore(prefix: string, script: string): Promise<{ root: string; core: AtelierCore }> {
  const root = createTemporaryRepository(prefix);
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { check: script } }), "utf8");
  const packageCommit = spawnSync("git", ["add", "package.json"], { cwd: root, encoding: "utf8", shell: false });
  assert.equal(packageCommit.status, 0, packageCommit.stderr);
  const baseline = spawnSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "test: record quality gate baseline"], { cwd: root, encoding: "utf8", shell: false });
  assert.equal(baseline.status, 0, baseline.stderr);
  writeFileSync(`${root}/.atelier/validation.json`, JSON.stringify({ validations: {}, closurePolicy: { requireValidation: false } }), "utf8");
  writeFileSync(`${root}/.atelier/PLAN.md`, VALID_PLAN, "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  core.beginPlan("Bind quality-gate evidence");
  const review = core.beginPlanReview();
  core.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await core.execution.prepare();
  assert.equal(prepared.approval.qualityGatePlan?.selectedGateId, "npm:check");
  await core.execution.approveAndApply(prepared.approval.id, true);
  return { root, core };
}

test("quality-gate discovery is read-only, deterministic, and reports configured alternatives", async () => {
  const root = createTemporaryRepository("atlr-quality-gates-discovery-");
  const marker = `${root}/discovery-ran`;
  writeFileSync(`${root}/hk.pkl`, "# hk profile\n", "utf8");
  writeFileSync(`${root}/mise.toml`, "[tasks.check]\nrun = \"echo mise\"\n", "utf8");
  writeFileSync(`${root}/.gitattributes`, "*.txt filter=example\n", "utf8");
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { check: `node -e \"require('fs').writeFileSync('${marker}', 'ran')\"` } }), "utf8");
  const globalConfig = `${root}/global.gitconfig`;
  writeFileSync(globalConfig, "[user]\n\tsigningKey = test-signing-key\n", "utf8");
  const { gates, ledger } = service(root, {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  try {
    const first = await gates.discover();
    const second = await gates.discover();
    assert.equal(first.digest, second.digest);
    assert.equal(first.selectedGateId, "hk:check");
    assert.deepEqual(first.gates.map((gate) => gate.kind), ["hk", "mise", "npm"]);
    assert.equal(first.gates.every((gate) => gate.command !== undefined), true);
    assert.equal(first.gates.some((gate) => gate.reason?.includes("arbitrary")), false);
    assert.equal(first.omissions.length, 0);
    assert.equal(first.sourceFiles.some((source) => source.path === "package.json"), true);
    assert.equal(first.gitPolicy.filtersConfigured, true);
    assert.equal(first.gitPolicy.signingConfigured, true);
    assert.equal(first.gitPolicy.hooksPathExternal, false);
    const bounded = await gates.discover({ maxFileBytes: 4 });
    assert.equal(bounded.sourceFiles.some((source) => source.truncated), true);
    assert.equal(existsSync(marker), false);
  } finally {
    ledger.close();
  }
});

test("quality-gate discovery exposes unsupported, conflicting, and no-gate states without executing configuration", async () => {
  const emptyRoot = createTemporaryRepository("atlr-quality-gates-empty-");
  const empty = service(emptyRoot);
  try {
    const profile = await empty.gates.discover();
    assert.equal(profile.noGate, true);
    assert.equal(profile.selectedGateId, undefined);
    assert.ok(profile.gates.some((gate) => gate.kind === "no-gate"));
    const result = await empty.gates.run("no-gate");
    assert.equal(result.status, "blocked");
  } finally {
    empty.ledger.close();
  }

  const conflictingRoot = createTemporaryRepository("atlr-quality-gates-conflicting-");
  writeFileSync(`${conflictingRoot}/.pre-commit-config.yaml`, "repos: []\n", "utf8");
  writeFileSync(`${conflictingRoot}/.pre-commit-config.yml`, "repos: []\n", "utf8");
  const conflicting = service(conflictingRoot);
  try {
    const profile = await conflicting.gates.discover();
    const conflict = profile.gates.find((gate) => gate.id === "prek:conflict");
    assert.equal(conflict?.availability, "conflicting");
    assert.equal(conflict?.supported, false);
  } finally {
    conflicting.ledger.close();
  }

  const unsupportedRoot = createTemporaryRepository("atlr-quality-gates-unsupported-");
  writeFileSync(`${unsupportedRoot}/devenv.nix`, "{ pkgs, ... }: { }\n", "utf8");
  writeFileSync(`${unsupportedRoot}/.git/hooks/pre-commit`, "#!/bin/sh\nexit 0\n", "utf8");
  const unsupported = service(unsupportedRoot);
  try {
    const profile = await unsupported.gates.discover();
    const devenv = profile.gates.find((gate) => gate.kind === "devenv");
    assert.equal(devenv?.supported, false);
    assert.match(devenv?.reason ?? "", /unsupported/i);
    const native = profile.gates.find((gate) => gate.kind === "native-git-hook");
    assert.equal(native?.supported, false);
    assert.match(native?.reason ?? "", /direct execution/i);
  } finally {
    unsupported.ledger.close();
  }

  const unavailableRoot = createTemporaryRepository("atlr-quality-gates-unavailable-");
  writeFileSync(`${unavailableRoot}/hk.pkl`, "# hk profile\n", "utf8");
  const unavailable = service(unavailableRoot, { PATH: "" });
  try {
    const profile = await unavailable.gates.discover();
    const hk = profile.gates.find((gate) => gate.kind === "hk");
    assert.equal(hk?.availability, "missing_tool");
    assert.equal(profile.noGate, true);
  } finally {
    unavailable.ledger.close();
  }

  const cancelledRoot = createTemporaryRepository("atlr-quality-gates-discovery-cancelled-");
  const cancelled = service(cancelledRoot);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(cancelled.gates.discover({ signal: controller.signal }), /cancelled/i);
  } finally {
    cancelled.ledger.close();
  }
});

test("quality-gate runs use bounded redacted output and detect repository mutation", async () => {
  const root = createTemporaryRepository("atlr-quality-gates-run-");
  writeFileSync(`${root}/package.json`, JSON.stringify({
    scripts: { check: "node -e \"console.log('password=super-secret-value')\"" },
  }), "utf8");
  const { gates, ledger } = service(root);
  try {
    const profile = await gates.discover();
    const result = await gates.run(profile.selectedGateId!);
    assert.equal(result.status, "passed");
    assert.doesNotMatch(result.stdout, /super-secret-value/);
    assert.equal(result.gateId, "npm:check");
    assert.ok(result.profileDigest.length > 0);
    assert.equal(result.stdoutTruncated, false);

    writeFileSync(`${root}/package.json`, JSON.stringify({
      scripts: { check: "node -e \"process.stdout.write('x'.repeat(5000))\"" },
    }), "utf8");
    const boundedProfile = await gates.discover();
    const bounded = await gates.run(boundedProfile.selectedGateId!, { maxOutputBytes: 1024 });
    assert.equal(bounded.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(bounded.stdout, "utf8") <= 1024);

    writeFileSync(`${root}/package.json`, JSON.stringify({
      scripts: { check: "node -e \"require('fs').writeFileSync('generated.txt', 'changed')\"" },
    }), "utf8");
    const changedProfile = await gates.discover();
    const changed = await gates.run(changedProfile.selectedGateId!);
    assert.equal(changed.status, "mutation_detected");
    assert.ok(changed.changedPathsAfter.includes("generated.txt"));
  } finally {
    ledger.close();
  }
});

test("quality-gate planning inventory identifies covered and missing paths without running checks", async () => {
  const root = createTemporaryRepository("atlr-quality-gates-planning-");
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { check: "echo check" } }), "utf8");
  const { gates, ledger } = service(root);
  try {
    const profile = await gates.discover();
    const inventory = qualityGatePlanningInventory(profile, [`${root}/packages/core`, `${root}/docs`]);
    assert.equal(inventory.selectedGateId, "npm:check");
    assert.deepEqual(inventory.missingPaths, []);
    assert.equal(inventory.coverage.every((item) => item.covered), true);
    assert.equal(inventory.digest.length, 64);

    const noGateRoot = createTemporaryRepository("atlr-quality-gates-planning-empty-");
    const noGateService = service(noGateRoot);
    try {
      const noGate = await noGateService.gates.discover();
      const missing = qualityGatePlanningInventory(noGate, [`${noGateRoot}/src`]);
      assert.equal(missing.missingPaths.length, 1);
      assert.ok(missing.proposals.length > 0);
    } finally {
      noGateService.ledger.close();
    }
  } finally {
    ledger.close();
  }
});

test("quality-gate runs honor cancellation without turning it into success", async () => {
  const root = createTemporaryRepository("atlr-quality-gates-cancel-");
  writeFileSync(`${root}/package.json`, JSON.stringify({
    scripts: { check: "node -e \"setTimeout(() => {}, 10000)\"" },
  }), "utf8");
  const { gates, ledger } = service(root);
  try {
    const profile = await gates.discover();
    const controller = new AbortController();
    const pending = gates.run(profile.selectedGateId!, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.passed, false);
  } finally {
    ledger.close();
  }
});

test("new plan preparation treats legacy required validations as compatibility-only", async () => {
  const root = createTemporaryRepository("atlr-quality-gate-legacy-plan-");
  writeFileSync(`${root}/.atelier/PLAN.md`, VALID_PLAN, "utf8");
  writeFileSync(`${root}/.atelier/validation.json`, JSON.stringify({ validations: {
    legacy: { command: [process.execPath, "-e", "process.exit(0)"], category: "focused", focused: true, required: true },
  } }), "utf8");
  const core = AtelierCore.open(root, { taskProvider: "memory", codeProvider: new DisabledCodeProvider() });
  try {
    core.beginPlan("Use repository quality gates");
    const review = core.beginPlanReview();
    core.completePlanReview(review.id, { exitCode: 0 });
    const prepared = await core.execution.prepare();
    assert.equal(prepared.approval.qualityGateMode, "quality-gates");
    assert.deepEqual(prepared.approval.taskConstraints.flatMap((item) => item.focusedValidations), []);
    const started = await core.execution.approveAndApply(prepared.approval.id, true);
    assert.ok(started.executionGrant);
    const readiness = core.taskClosureReadiness();
    assert.equal(readiness.validationReady, true);
    assert.deepEqual(readiness.required, []);
    assert.match(readiness.reason, /quality gate|local committed change|diff/i);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected quality-gate failure refuses commit and records exact evidence", async () => {
  const { root, core } = await activeQualityCore("atlr-quality-gate-commit-failure-", "node -e \"process.exit(1)\"");
  try {
    writeFileSync(`${root}/src.ts`, "export const blocked = true;\n", "utf8");
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    await assert.rejects(
      core.commitActiveTask("feat: blocked by quality gate"),
      (error: unknown) => error instanceof QualityGatePolicyError && error.evidence.status === "failed",
    );
    const evidence = core.ledger.getState<{ status: string; passed: boolean; command?: string[]; stdout: string; stderr: string }>(
      `qualityGateEvidence:${grant.id}:commit`,
    );
    assert.equal(evidence?.status, "failed");
    assert.equal(evidence?.passed, false);
    assert.deepEqual(evidence?.command, ["npm", "run", "check"]);
    assert.equal(typeof evidence?.stdout, "string");
    assert.equal(typeof evidence?.stderr, "string");
    assert.equal(core.repository.snapshot().headCommit, grant.repositorySnapshot.headCommit);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate mutation refuses commit and records a fresh diff requirement", async () => {
  const { root, core } = await activeQualityCore("atlr-quality-gate-mutation-", "node -e \"require('fs').writeFileSync('generated.ts', 'changed')\"");
  try {
    writeFileSync(`${root}/src.ts`, "export const mutated = true;\n", "utf8");
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    await assert.rejects(
      core.commitActiveTask("feat: formatter mutation blocked"),
      (error: unknown) => error instanceof QualityGatePolicyError && error.evidence.status === "mutation_detected",
    );
    const evidence = core.ledger.getState<{ status: string; mutationDetected: boolean }>(`qualityGateEvidence:${grant.id}:commit`);
    assert.equal(evidence?.status, "mutation_detected");
    assert.equal(evidence?.mutationDetected, true);
    assert.equal(existsSync(`${root}/generated.ts`), true);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate profile drift refuses commit as stale instead of reusing a pass", async () => {
  const { root, core } = await activeQualityCore("atlr-quality-gate-stale-", "node -e \"process.exit(0)\"");
  try {
    writeFileSync(`${root}/src.ts`, "export const stale = true;\n", "utf8");
    const configChange = spawnSync("git", ["config", "user.name", "Changed after approval"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(configChange.status, 0, configChange.stderr);
    const grant = core.ledger.getActiveExecutionGrant();
    assert.ok(grant);
    await assert.rejects(
      core.commitActiveTask("feat: stale quality gate"),
      (error: unknown) => error instanceof QualityGatePolicyError && error.evidence.status === "stale",
    );
    const evidence = core.ledger.getState<{ status: string; reason?: string }>(`qualityGateEvidence:${grant.id}:commit`);
    assert.equal(evidence?.status, "stale");
    assert.match(evidence?.reason ?? "", /fresh transaction/i);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("passed quality-gate evidence is required again for closure and then allows close", async () => {
  const { root, core } = await activeQualityCore("atlr-quality-gate-closure-", "node -e \"process.exit(0)\"");
  try {
    writeFileSync(`${root}/src.ts`, "export const closable = true;\n", "utf8");
    await core.commitActiveTask("feat: pass quality gate before commit");
    const preview = core.previewFinalDiff();
    core.reviewFinalDiff(preview.diffHash);
    const beforeClose = core.taskClosureReadiness();
    assert.equal(beforeClose.qualityGate?.required, true);
    assert.equal(beforeClose.qualityGate?.ready, false);
    assert.match(beforeClose.reason, /quality gate/i);
    const result = await core.closeActiveTask("quality gate evidence is current");
    assert.equal(result.task.status, "closed");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
