import assert from "node:assert/strict";
import test from "node:test";
import { parsePlanText, updatePlanTaskScopeText } from "../packages/core/src/index.ts";

const PLAN = `# Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Example
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task"} -->

### Goal

Ship it.

### Scope

- src/example.ts

### Out of scope

- Dependencies

### Depends on

- None

### Validation

- unit

### Completion criteria

- Tests pass

### Notes

- Keep it small.
`;

test("plan scope editor writes canonical metadata and a readable authorization section", () => {
  const updated = updatePlanTaskScopeText(PLAN, {
    taskId: "ATLR-001",
    execution: {
      writePaths: ["tests/example.test.ts", "src/example.ts", "src/example.ts"],
      allowDependencyChanges: false,
      validations: ["unit", "unit"],
      allowFullSuite: false,
      allowLocalChange: true,
    },
  });
  const parsed = parsePlanText(updated);
  assert.deepEqual(parsed.tasks[0]?.execution, {
    writePaths: ["src/example.ts", "tests/example.test.ts"],
    allowDependencyChanges: false,
    validations: ["unit"],
    allowFullSuite: false,
    allowLocalChange: true,
  });
  assert.match(updated, /### Authorization/);
  assert.match(updated, /Writable paths: `src\/example\.ts`, `tests\/example\.test\.ts`/);
  assert.match(updated, /Dependency changes: not allowed/);
});
