import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../packages/core/src/config/config.ts";

const TEST_STATE_ROOT = mkdtempSync(join(tmpdir(), `atlr-test-state-${process.pid}-`));
process.env.ATLR_STATE_HOME = join(TEST_STATE_ROOT, "runtime");

export const VALID_PLAN = `# Atelier Test Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Establish guarded core
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["packages/core","src","src.ts"],"allowDependencyChanges":false,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Create the guarded core.

### Scope

- packages/core

### Out of scope

- UI polish

### Depends on

- None

### Validation

- Run unit tests

### Completion criteria

- Policy tests pass

### Notes

- Keep the implementation deterministic

## ATLR-002 — Add task-backed working state
<!-- atlr:task {"id":"ATLR-002","priority":2,"type":"feature","execution":{"writePaths":["packages/core/src/state"],"allowDependencyChanges":false,"validations":[],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Build Working State from durable task state.

### Scope

- Working state builder

### Out of scope

- Embeddings

### Depends on

- ATLR-001

### Validation

- Run integration tests

### Completion criteria

- Ready task selection is deterministic

### Notes

- Current source remains authoritative
`;

export function createTemporaryRepository(prefix = "atlr-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(
    join(root, ".atelier", "config.json"),
    `${JSON.stringify(
      {
        planPath: ".atelier/PLAN.md",
        taskProvider: "memory",
        codeProvider: "disabled",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const git = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", shell: false });
  if (git.status !== 0) throw new Error(git.stderr || "Unable to initialize test Git repository");
  for (const [key, value] of [
    ["user.name", "Atelier Tests"],
    ["user.email", "atelier-tests@example.invalid"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
  ] as const) {
    const configured = spawnSync("git", ["config", key, value], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    if (configured.status !== 0) throw new Error(configured.stderr || `Unable to configure test Git ${key}`);
  }
  writeFileSync(join(root, "README.md"), "# Atelier test repository\n", "utf8");
  const committed = spawnSync("git", ["add", "README.md"], { cwd: root, encoding: "utf8", shell: false });
  if (committed.status !== 0) throw new Error(committed.stderr || "Unable to stage test repository baseline");
  const initial = spawnSync(
    "git",
    ["commit", "--quiet", "--no-gpg-sign", "-m", "test: initialize repository"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (initial.status !== 0) throw new Error(initial.stderr || "Unable to commit test repository baseline");
  return root;
}

export function testDatabasePath(root: string): string {
  return loadConfig(root).databasePath;
}
