import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const VALID_PLAN = `# Atelier Test Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Establish guarded core
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task"} -->

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
<!-- atlr:task {"id":"ATLR-002","priority":2,"type":"feature"} -->

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
        databasePath: ".atelier/atelier.db",
        taskProvider: "memory",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const git = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", shell: false });
  if (git.status !== 0) throw new Error(git.stderr || "Unable to initialize test Git repository");
  return root;
}
