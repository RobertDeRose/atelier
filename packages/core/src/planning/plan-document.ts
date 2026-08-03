import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_PLAN_TEMPLATE = `# Implementation Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — First implementation task
<!-- atlr:task
{
  "id": "ATLR-001",
  "priority": 1,
  "type": "task",
  "execution": {
    "writePaths": [
      "src/example.ts",
      "tests/example.test.ts"
    ],
    "allowDependencyChanges": false,
    "validations": [],
    "allowFullSuite": false,
    "allowLocalChange": true
  }
}
-->

### Goal

Describe the outcome this task must produce.

### Scope

- Name every writable repository-relative source path from execution.writePaths and describe the behavior included in this task.

### Out of scope

- List adjacent work that must not be performed as part of this task.

### Depends on

- None

### Validation

- Name the configured validations listed in execution.validations and describe any manual checks.

### Completion criteria

- State the observable conditions that must be true before this task can close.

### Notes

- Record decisions, risks, and implementation constraints that must survive Working State reconstruction.
`;

export function ensurePlanDocument(path: string, template = DEFAULT_PLAN_TEMPLATE): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, template, "utf8");
  return true;
}

export function readPlanDocument(path: string): string {
  return readFileSync(path, "utf8");
}
