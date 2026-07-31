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
    ]) {
      writeFileSync(join(guidedRoot, "guides", guide), `# ${guide}\n`, "utf8");
    }


    executable(join(fakeBin, "mise"), '[[ "${1:-}" == run && "${2:-}" == launch ]]');
    executable(
      join(fakeBin, "node"),
      'if [[ "${1:-}" == "--input-type=module" ]]; then exec "$REAL_NODE" "$@"; fi\nprintf "[]\\n"',
    );
    executable(join(fakeBin, "git"), "exit 0");
    executable(join(fakeBin, "jj"), "exit 0");
    executable(join(fakeBin, "bd"), 'printf "[]\\n"');

    // Starting at step 3 exercises checkpoint collection plus the shared control
    // workspace used by steps 4 and 5. Each step consumes Enter, PASS, and notes.
    const input = "\np\n\n\np\n\n\np\n\n";
    const result = spawnSync("bash", [script, "guided", "3"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        ATELIER_ACCEPTANCE_POINTER: pointer,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        REAL_NODE: process.execPath,
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
    const input = "\np\n\n\np\n\n\np\n\n";
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
