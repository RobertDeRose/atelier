import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(process.cwd(), "scripts", "guided-verification.sh");

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

test("guided verification help renders without executing Markdown-style commands", () => {
  const result = spawnSync("bash", [script, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TERM: "dumb" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /retry STEP/);
  assert.match(result.stdout, /retried with: retry 4/);
});

test("evidence archive setup prefers GNU tar when gtar is available", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-guided-gtar-"));
  const fakeBin = join(root, "bin");
  try {
    mkdirSync(fakeBin, { recursive: true });
    executable(join(fakeBin, "gtar"), "exit 0");
    executable(join(fakeBin, "tar"), "exit 99");

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; archive_tar_setup; printf "%s\n" "$ARCHIVE_TAR_BIN"', "bash", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`, TERM: "dumb" },
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), join(fakeBin, "gtar"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guided verification resolves step workspace paths before launching and collecting evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-guided-paths-"));
  const runRoot = join(root, "run");
  const guidedRoot = join(runRoot, "guided");
  const evidence = join(runRoot, "evidence");
  const fakeBin = join(root, "bin");
  const pointer = join(root, "pointer");

  try {
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(pointer, `${runRoot}\n`, "utf8");
    writeFileSync(join(runRoot, "env.sh"), "export ATELIER_TEST_RUN=1\n", "utf8");

    for (const name of ["intel-jj", "policy-git", "policy-jj", "control"] as const) {
      const workspace = join(guidedRoot, name);
      const repo = join(workspace, "repo");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(workspace, "env.sh"),
        `export ATELIER_MANUAL_ROOT=${JSON.stringify(workspace)}\nexport ATLR_REPO=${JSON.stringify(repo)}\n`,
        "utf8",
      );
    }
    mkdirSync(join(guidedRoot, "guides"), { recursive: true });
    for (const guide of [
      "01-intel-jj.md",
      "02-policy-git.md",
      "03-policy-jj.md",
      "04-approval.md",
      "05-control.md",
      "05a-control-implementation.md",
      "05b-control-stop.md",
      "05c-control-actions.md",
    ]) {
      writeFileSync(join(guidedRoot, "guides", guide), `# ${guide}\n`, "utf8");
    }
    writeFileSync(join(guidedRoot, ".prepared"), "", "utf8");

    executable(join(fakeBin, "mise"), '[[ "${1:-}" == run && "${2:-}" == launch ]]');
    executable(
      join(fakeBin, "node"),
      'if [[ "${1:-}" == "--input-type=module" ]]; then exec "$REAL_NODE" "$@"; fi\nprintf "[]\\n"',
    );
    executable(join(fakeBin, "git"), "exit 0");
    executable(join(fakeBin, "jj"), "exit 0");
    executable(join(fakeBin, "bd"), 'printf "[]\\n"');

    // Starting at step 3 exercises checkpoint collection plus the shared control
    // workspace used by steps 4 and 5. Steps 3 and 4 consume Enter, PASS, and notes.
    // Step 5 uses three separately launched Pi phases, then one PASS/notes result.
    const input = "\np\n\n\np\n\n\n\n\np\n\n";
    const result = spawnSync("bash", [script, "guided", "3"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
        ATELIER_GUIDED_TEST_ALLOW_EMPTY_RECOVERY: "1",
        ATELIER_GUIDED_TEST_MODE: "1",
        ATELIER_GUIDED_TEST_SKIP_OBJECTIVE: "1",
        TERM: "dumb",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /guided verification complete/);
    const results = readFileSync(join(evidence, "manual-results.tsv"), "utf8");
    assert.match(results, /^3\tPASS\t/m);
    assert.match(results, /^4\tPASS\t/m);
    assert.match(results, /^5\tPASS\t/m);
    assert.equal(existsSync(join(runRoot, "atelier-guided-verification-evidence.tar.xz")), true);
    assert.equal(existsSync(join(evidence, "guided-policy-jj", "status.json")), true);
    assert.equal(existsSync(join(evidence, "guided-control", "status.json")), true);
    assert.equal(
      readFileSync(join(evidence, "guided-policy-jj", "pi-command.txt"), "utf8"),
      "mise run launch -- -ne --no-session\n",
      "guided Pi launches must isolate unrelated user extensions",
    );
    const footerGuide = readFileSync(join(guidedRoot, "guides", "01-intel-jj.md"), "utf8");
    assert.match(footerGuide, /thinking-level shortcut to select a different level/i);
    assert.match(footerGuide, /must change immediately without running an Atelier command/i);
    assert.match(footerGuide, /model and thinking-level values update immediately/i);
    const refreshedGuide = readFileSync(join(guidedRoot, "guides", "02-policy-git.md"), "utf8");
    assert.match(refreshedGuide, /Inside Pi, run `\/status` first\. The footer must use `git:` and `intel: disabled`\./);
    assert.match(refreshedGuide, /typed create and edit are blocked because investigate mode is read-only/i);
    assert.match(refreshedGuide, /dirty tracked, untracked, and ignored deletions each create a verified checkpoint/i);
    assert.match(refreshedGuide, /Working….*indicator clears/is);
    assert.match(refreshedGuide, /stop without restating the command or its output/i);
    assert.match(refreshedGuide, /Make exactly one Bash tool call, then stop without restating/i);
    const approvalGuide = readFileSync(join(guidedRoot, "guides", "04-approval.md"), "utf8");
    assert.match(approvalGuide, /do not replace or repair the generated plan/i);
    assert.match(approvalGuide, /<!-- atlr:task\n\{/);
    assert.match(approvalGuide, /"validations": \[\s*"manual-acceptance"\s*\]/);
    const controlGuide = readFileSync(join(guidedRoot, "guides", "05-control.md"), "utf8");
    assert.match(controlGuide, /three separate Pi sessions/i);
    const implementationGuide = readFileSync(join(guidedRoot, "guides", "05a-control-implementation.md"), "utf8");
    assert.match(implementationGuide, /Do not run `\/atelier-stop` during this implementation turn/i);
    assert.match(implementationGuide, /exact TypeScript source specifier `\.\.\/packages\/core\/src\/version\.ts`/i);
    const stopGuide = readFileSync(join(guidedRoot, "guides", "05b-control-stop.md"), "utf8");
    assert.match(stopGuide, /only the current turn stops/i);
    assert.equal((stopGuide.match(/task and execution grant/g) ?? []).length, 2);
    const controlsGuide = readFileSync(join(guidedRoot, "guides", "05c-control-actions.md"), "utf8");
    assert.match(controlsGuide, /Using only the typed edit tool, add the exact line `\/\/ pause-probe`/);
    assert.match(controlsGuide, /footer must change to `mode: paused` immediately/i);
    assert.equal(existsSync(join(evidence, "guided-control-implementation")), true);
    assert.equal(existsSync(join(evidence, "guided-control-stop")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guided verification auto-prepares missing workspaces and does not emit terminal-reset escapes before TUI launch", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-guided-autoprepare-"));
  const runRoot = join(root, "run");
  const automatedRepo = join(runRoot, "repo");
  const sourceRepo = join(root, "source");
  const evidence = join(runRoot, "evidence");
  const fakeBin = join(root, "bin");
  const pointer = join(root, "pointer");

  try {
    mkdirSync(join(automatedRepo, ".git"), { recursive: true });
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(pointer, `${runRoot}\n`, "utf8");
    writeFileSync(join(runRoot, "env.sh"), "export ATELIER_TEST_RUN=1\n", "utf8");

    executable(
      join(fakeBin, "git"),
      [
        'if [[ "${1:-}" == "-C" && "${3:-}" == "remote" && "${4:-}" == "get-url" ]]; then',
        '  printf "%s\\n" "$FAKE_SOURCE_REPO"',
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "clone" ]]; then',
        '  destination="${@: -1}"',
        '  mkdir -p "$destination/.git" "$destination/.beads" "$destination/.atelier" "$destination/bin" "$destination/tests" "$destination/packages/core/src"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    executable(join(fakeBin, "mise"), "exit 0");
    executable(join(fakeBin, "jj"), "exit 0");
    executable(join(fakeBin, "bd"), 'printf "[]\\n"');
    executable(
      join(fakeBin, "node"),
      'if [[ "${1:-}" == "--input-type=module" ]]; then exec "$REAL_NODE" "$@"; fi\nprintf "[]\\n"',
    );

    // Starting at step 3 keeps the regression bounded while still exercising
    // automatic preparation, TUI launch, evidence collection, and archiving.
    // Step 5 launches implementation, stop, and control phases separately.
    const input = "\np\n\n\np\n\n\n\n\np\n\n";
    const result = spawnSync("bash", [script, "guided", "3"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        FAKE_SOURCE_REPO: sourceRepo,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
        ATELIER_GUIDED_TEST_ALLOW_EMPTY_RECOVERY: "1",
        ATELIER_GUIDED_TEST_MODE: "1",
        ATELIER_GUIDED_TEST_SKIP_OBJECTIVE: "1",
        TERM: "xterm-256color",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /guided workspaces are missing or incomplete; preparing them now/);
    assert.match(result.stdout, /guided verification complete/);
    assert.equal(existsSync(join(runRoot, "guided", "intel-jj", "repo")), true);
    assert.equal(existsSync(join(runRoot, "guided", "policy-git", "repo")), true);
    assert.equal(existsSync(join(runRoot, "guided", "policy-jj", "repo")), true);
    assert.equal(existsSync(join(runRoot, "guided", "control", "repo")), true);
    assert.equal(existsSync(join(runRoot, "guided", ".prepared")), true);

    const footerGuide = readFileSync(join(runRoot, "guided", "guides", "01-intel-jj.md"), "utf8");
    assert.match(footerGuide, /must change immediately without running an Atelier command/i);
    const policyGuide = readFileSync(join(runRoot, "guided", "guides", "02-policy-git.md"), "utf8");
    assert.match(policyGuide, /Inside Pi, run `\/status` first\. The footer must use `git:` and `intel: disabled`\./);
    assert.match(policyGuide, /`!rm manual-policy\/clean-delete\.txt`/);
    assert.match(policyGuide, /`!rm manual-policy\/untracked-delete\.txt`/);
    assert.match(policyGuide, /`!rm manual-policy\/ignored-delete\.txt`/);
    assert.match(policyGuide, /`!cat \.env\.acceptance`/);
    assert.match(policyGuide, /When each approval prompt appears, choose \*\*No\*\*/);
    const outsideCommand = "`!printf 'outside\\n' > \"" + join(runRoot, "outside-write-must-not-exist.txt") + "\"`";
    assert.equal(policyGuide.includes(outsideCommand), true, `missing rendered outside-workspace command: ${outsideCommand}`);

    const missingPointer = spawnSync("bash", [script, "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: join(root, "missing-pointer"),
        TERM: "xterm-256color",
      },
    });
    assert.notEqual(missingPointer.status, 0);
    assert.match(missingPointer.stderr, /no current acceptance run/);
    assert.doesNotMatch(missingPointer.stdout + missingPointer.stderr, /\u001b\[\?1049l/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guided retry recreates only the failed workspace and preserves prior results", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-guided-retry-"));
  const runRoot = join(root, "run");
  const automatedRepo = join(runRoot, "repo");
  const sourceRepo = join(root, "source");
  const evidence = join(runRoot, "evidence");
  const fakeBin = join(root, "bin");
  const pointer = join(root, "pointer");

  try {
    mkdirSync(join(automatedRepo, ".git"), { recursive: true });
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(pointer, `${runRoot}\n`, "utf8");
    writeFileSync(join(runRoot, "env.sh"), "export ATELIER_TEST_RUN=1\n", "utf8");
    writeFileSync(
      join(evidence, "manual-results.tsv"),
      "1\tPASS\tJujutsu footer\tkept\n2\tFAIL\tGit policy\told failure\n",
      "utf8",
    );

    executable(
      join(fakeBin, "git"),
      [
        'if [[ "${1:-}" == "-C" && "${3:-}" == "remote" && "${4:-}" == "get-url" ]]; then',
        '  printf "%s\\n" "$FAKE_SOURCE_REPO"',
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "clone" ]]; then',
        '  destination="${@: -1}"',
        '  mkdir -p "$destination/.git" "$destination/.beads" "$destination/.atelier" "$destination/bin" "$destination/tests" "$destination/packages/core/src"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    executable(
      join(fakeBin, "mise"),
      [
        'if [[ "${1:-}" == "run" && "${2:-}" == "launch" ]]; then',
        '  printf "captured launch diagnostic\\n" >&2',
        "fi",
        "exit 0",
      ].join("\n"),
    );
    executable(join(fakeBin, "jj"), "exit 0");
    executable(join(fakeBin, "bd"), 'printf "[]\\n"');
    executable(
      join(fakeBin, "node"),
      'if [[ "${1:-}" == "--input-type=module" ]]; then exec "$REAL_NODE" "$@"; fi\nprintf "[]\\n"',
    );

    const result = spawnSync("bash", [script, "retry", "2"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "\np\nretried\n",
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        FAKE_SOURCE_REPO: sourceRepo,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
        ATELIER_GUIDED_TEST_ALLOW_EMPTY_RECOVERY: "1",
        ATELIER_GUIDED_TEST_MODE: "1",
        ATELIER_GUIDED_TEST_SKIP_OBJECTIVE: "1",
        TERM: "dumb",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /guided step 2 retry complete/);
    const results = readFileSync(join(evidence, "manual-results.tsv"), "utf8");
    assert.match(results, /^1\tPASS\tJujutsu footer\tkept$/m);
    assert.match(results, /^2\tPASS\tGit recoverability and consequence-based prompts\tretried$/m);
    assert.doesNotMatch(results, /^2\tFAIL\t/m);
    assert.equal(readFileSync(join(evidence, "guided-policy-git", "pi-exit-status.txt"), "utf8"), "0\n");
    assert.match(readFileSync(join(evidence, "guided-policy-git", "pi.stderr"), "utf8"), /captured launch diagnostic/);
    assert.equal(existsSync(join(runRoot, "guided", "policy-git", "repo")), true);

    executable(
      join(fakeBin, "mise"),
      [
        'if [[ "${1:-}" == "run" && "${2:-}" == "launch" ]]; then',
        '  printf "fatal launch diagnostic\\n" >&2',
        "  exit 7",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    const failedRetry = spawnSync("bash", [script, "retry", "2"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "\nexpected failure\n",
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        ATELIER_GUIDED_KEEP_GOING: "1",
        FAKE_SOURCE_REPO: sourceRepo,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
        ATELIER_GUIDED_TEST_ALLOW_EMPTY_RECOVERY: "1",
        ATELIER_GUIDED_TEST_MODE: "1",
        ATELIER_GUIDED_TEST_SKIP_OBJECTIVE: "1",
        TERM: "dumb",
      },
    });
    assert.equal(failedRetry.status, 0, `${failedRetry.stdout}\n${failedRetry.stderr}`);
    assert.match(failedRetry.stderr, /Pi exited unexpectedly with status 7/);
    assert.equal(readFileSync(join(evidence, "guided-policy-git", "pi-exit-status.txt"), "utf8"), "7\n");
    assert.match(readFileSync(join(evidence, "guided-policy-git", "pi.stderr"), "utf8"), /fatal launch diagnostic/);
    const failedResults = readFileSync(join(evidence, "manual-results.tsv"), "utf8");
    assert.match(failedResults, /^1\tPASS\tJujutsu footer\tkept$/m);
    assert.match(failedResults, /^2\tFAIL\tGit recoverability and consequence-based prompts\texpected failure$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guided Git policy restores every path-scoped checkpoint and prints concrete evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-guided-recovery-"));
  const runRoot = join(root, "run");
  const automatedRepo = join(runRoot, "repo");
  const sourceRepo = join(root, "source");
  const evidence = join(runRoot, "evidence");
  const fakeBin = join(root, "bin");
  const pointer = join(root, "pointer");
  const restoreLog = join(root, "restored.txt");

  try {
    mkdirSync(join(automatedRepo, ".git"), { recursive: true });
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(pointer, `${runRoot}\n`, "utf8");
    writeFileSync(join(runRoot, "env.sh"), "export ATELIER_TEST_RUN=1\n", "utf8");

    executable(
      join(fakeBin, "git"),
      [
        'if [[ "${1:-}" == "-C" && "${3:-}" == "remote" && "${4:-}" == "get-url" ]]; then',
        '  printf "%s\\n" "$FAKE_SOURCE_REPO"',
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "clone" ]]; then',
        '  destination="${@: -1}"',
        '  mkdir -p "$destination/.git" "$destination/.beads" "$destination/.atelier" "$destination/bin" "$destination/tests" "$destination/packages/core/src"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    executable(
      join(fakeBin, "mise"),
      [
        'if [[ "${1:-}" == "run" && "${2:-}" == "launch" ]]; then',
        '  rm -f manual-policy/dirty-delete.txt manual-policy/untracked-delete.txt manual-policy/ignored-delete.txt',
        "fi",
        "exit 0",
      ].join("\n"),
    );
    executable(join(fakeBin, "jj"), "exit 0");
    executable(join(fakeBin, "bd"), 'printf "[]\\n"');
    executable(
      join(fakeBin, "node"),
      [
        'if [[ "${1:-}" == "--input-type=module" ]]; then exec "$REAL_NODE" "$@"; fi',
        'if [[ "${2:-}" == "recovery" && "${3:-}" == "list" ]]; then',
        '  printf \'[{"id":"cp-ignored","paths":["%s/manual-policy/ignored-delete.txt"],"repositoryState":{"provider":"git"}},{"id":"cp-untracked","paths":["%s/manual-policy/untracked-delete.txt"],"repositoryState":{"provider":"git"}},{"id":"cp-dirty","paths":["%s/manual-policy/dirty-delete.txt"],"repositoryState":{"provider":"git"}}]\\n\' "$ATLR_REPO" "$ATLR_REPO" "$ATLR_REPO"',
        "  exit 0",
        "fi",
        'if [[ "${2:-}" == "recovery" && "${3:-}" == "restore" ]]; then',
        '  printf "%s\\n" "${4:-}" >> "$RESTORE_LOG"',
        '  case "${4:-}" in',
        '    cp-ignored) printf "ignored contents\\n" > manual-policy/ignored-delete.txt ;;',
        '    cp-untracked) printf "untracked contents\\n" > manual-policy/untracked-delete.txt ;;',
        '    cp-dirty) printf "dirty original\\ndirty uncommitted\\n" > manual-policy/dirty-delete.txt ;;',
        "  esac",
        '  printf "restored %s\\n" "${4:-}"',
        "  exit 0",
        "fi",
        'printf "[]\\n"',
      ].join("\n"),
    );

    const result = spawnSync("bash", [script, "retry", "2"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "\np\nrestored all checkpoints\n",
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        FAKE_SOURCE_REPO: sourceRepo,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
        ATELIER_GUIDED_TEST_MODE: "1",
        ATELIER_GUIDED_TEST_SKIP_OBJECTIVE: "1",
        RESTORE_LOG: restoreLog,
        TERM: "dumb",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Checkpoint cp-ignored/);
    assert.match(result.stdout, /Checkpoint cp-untracked/);
    assert.match(result.stdout, /Checkpoint cp-dirty/);
    assert.match(result.stdout, /Verified restored paths:/);
    assert.deepEqual(readFileSync(restoreLog, "utf8").trim().split("\n"), [
      "cp-ignored",
      "cp-untracked",
      "cp-dirty",
    ]);

    const repo = join(runRoot, "guided", "policy-git", "repo");
    assert.equal(readFileSync(join(repo, "manual-policy", "dirty-delete.txt"), "utf8"), "dirty original\ndirty uncommitted\n");
    assert.equal(readFileSync(join(repo, "manual-policy", "untracked-delete.txt"), "utf8"), "untracked contents\n");
    assert.equal(readFileSync(join(repo, "manual-policy", "ignored-delete.txt"), "utf8"), "ignored contents\n");
    assert.equal(existsSync(join(repo, "manual-policy", "typed-created.txt")), false);
    assert.equal(readFileSync(join(repo, "manual-policy", "clean-edit.txt"), "utf8"), "clean edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("live acceptance isolates unrelated user Pi extensions while loading Atelier explicitly", () => {
  const live = readFileSync(join(process.cwd(), "scripts", "live-acceptance.sh"), "utf8");
  assert.match(live, /launch -ne --mode json -p --no-session --no-approve/);
  assert.match(live, /mise run launch -- -ne/);
});


test("live acceptance treats only correlated in-workspace EISDIR reads as benign", () => {
  const live = join(process.cwd(), "scripts", "live-acceptance.sh");
  const result = spawnSync(
    "bash",
    [live, "self-check"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TERM: "dumb" } },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(readFileSync(live, "utf8"), /resume implementation/);
  const liveSource = readFileSync(live, "utf8");
  assert.match(liveSource, /do not read "\." or any directory/);
  assert.match(liveSource, /from \"\.\.\/packages\/core\/src\/version\.ts\"/);
  assert.match(liveSource, /version_test_import_contract/);
});

test("live acceptance verifies headless workspace denial from durable policy evidence", async () => {
  const script = readFileSync(join(process.cwd(), "scripts/live-acceptance.sh"), "utf8");
  assert.match(script, /jsonl_assert_tool_failed/);
  assert.match(script, /ledger-headless-shell-block\.json/);
  assert.match(script, /outside_workspace/);
  assert.doesNotMatch(script, /jsonl_assert_string \"\$EVIDENCE_DIR\/pi-headless-shell-block\.jsonl\"/);
});

test("guided acceptance verifies durable visual and model-Bash lifecycle evidence", () => {
  const source = readFileSync(script, "utf8");
  for (const kind of [
    "ui.report_presented",
    "ui.footer_presented",
    "ui.phase_changed",
    "ui.model_bash",
    "ui.agent_settled",
    "ui.user_bash_denied",
  ]) {
    assert.match(source, new RegExp(kind.replace(".", "\\.")), `missing durable ${kind} verification`);
  }
  assert.match(source, /status\.markdown\.sha256 !== workflow\.markdown\.sha256/);
  assert.match(source, /thinkingLevels\.size >= 2/);
  assert.match(source, /event\.payload\?\.hadOutput === true/);
  assert.match(source, /approve\.prepare/);
  assert.match(source, /approve\.activate/);
  assert.match(source, /COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1/);
  assert.match(source, /command -v gtar/);
  assert.match(source, /ARCHIVE_TAR_BIN/);
  assert.match(source, /--no-xattrs/);
  assert.match(source, /--no-mac-metadata/);
  assert.match(source, /--no-acls/);
  assert.match(source, /--no-fflags/);
  assert.match(source, /single_line_spinner_and_working/);
  assert.match(source, /native_working_indicator/);
  assert.match(source, /--exclude='guided\/\*\/repo\/node_modules'/);
  const phaseSource = readFileSync(join(process.cwd(), "apps/pi-extension/src/working-phase.ts"), "utf8");
  const footerSource = readFileSync(join(process.cwd(), "apps/pi-extension/src/status-presentation.ts"), "utf8");
  assert.match(phaseSource, /PHASE_WIDGET_KEY = "atelier-phase"/);
  assert.match(phaseSource, /placement: "aboveEditor"/);
  assert.match(phaseSource, /SPINNER_FRAMES/);
  assert.doesNotMatch(phaseSource, /setStatus\?\.\(ATELIER_PHASE_STATUS_KEY/);
  assert.doesNotMatch(footerSource, /atlr-phase|phaseStatus/);
});
