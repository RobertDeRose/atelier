import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanText } from "../packages/core/src/planning/plan-parser.ts";
import {
  createPlanStructureSnapshot,
  diffPlanStructures,
} from "../packages/core/src/planning/structural-plan-diff.ts";
import { VALID_PLAN } from "./fixtures.ts";

test("parses stable task metadata and dependencies", () => {
  const plan = parsePlanText(VALID_PLAN, "PLAN.md");

  assert.equal(plan.title, "Atelier Test Plan");
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.diagnostics.filter((item) => item.level === "error"), []);
  assert.equal(plan.tasks[0]?.id, "ATLR-001");
  assert.equal(plan.tasks[0]?.priority, 1);
  assert.equal(plan.tasks[1]?.type, "feature");
  assert.deepEqual(plan.tasks[1]?.dependencies, ["ATLR-001"]);
  assert.deepEqual(plan.tasks[0]?.execution?.writePaths, ["packages/core", "src", "src.ts"]);
  assert.deepEqual(plan.tasks[1]?.completionCriteria, ["Ready task selection is deterministic"]);
});

test("reports duplicate IDs, unknown dependencies, cycles, and missing completion criteria", () => {
  const invalid = `# Invalid\n\n## ATLR-001 — One\n### Depends on\n- ATLR-002\n### Completion criteria\n- Done\n\n## ATLR-002 — Two\n### Depends on\n- ATLR-001\n### Completion criteria\n\n## ATLR-001 — Duplicate\n### Depends on\n- ATLR-999\n### Completion criteria\n- Done\n`;
  const plan = parsePlanText(invalid, "PLAN.md");
  const codes = new Set(plan.diagnostics.map((item) => item.code));
  const cyclePlan = parsePlanText(`# Cycle\n\n## ATLR-A — A\n### Depends on\n- ATLR-B\n### Completion criteria\n- Done\n\n## ATLR-B — B\n### Depends on\n- ATLR-A\n### Completion criteria\n- Done\n`, "PLAN.md");

  assert.ok(codes.has("duplicate_task_id"));
  assert.ok(codes.has("unknown_dependency"));
  assert.ok(cyclePlan.diagnostics.some((item) => item.code === "dependency_cycle"));
  assert.ok(codes.has("missing_completion_criteria"));
});

test("structural plan diff covers every canonical task field in deterministic order", () => {
  const before = parsePlanText(`# Plan

## ATLR-001 — First
<!-- atlr:task {"id":"ATLR-001","priority":2,"type":"task"} -->
### Goal
Old goal
### Description
Old description
### Scope
- old scope
### Out of scope
- old exclusion
### Depends on
- None
### Validation
- old validation
### Completion criteria
- old criterion
### Notes
- old note

## ATLR-002 — Second
<!-- atlr:task {"id":"ATLR-002","priority":2,"type":"task"} -->
### Goal
Second goal
### Depends on
- ATLR-001
### Validation
- second validation
### Completion criteria
- second criterion
`, "PLAN.md");
  const after = parsePlanText(`# Plan

## ATLR-002 — Second
<!-- atlr:task {"id":"ATLR-002","priority":2,"type":"task"} -->
### Goal
Second goal
### Depends on
- None
### Validation
- second validation
### Completion criteria
- second criterion

## ATLR-001 — First changed
<!-- atlr:task {"id":"ATLR-001","priority":0,"type":"feature"} -->
### Goal
New goal
### Description
New description
### Scope
- new scope
### Out of scope
- new exclusion
### Depends on
- ATLR-002
### Validation
- new validation
### Completion criteria
- new criterion
### Notes
- new note

## ATLR-003 — Added
### Goal
Added goal
### Depends on
- None
### Validation
- added validation
### Completion criteria
- added criterion
`, "PLAN.md");

  const diff = diffPlanStructures(
    createPlanStructureSnapshot(before),
    createPlanStructureSnapshot(after),
  );

  assert.deepEqual(diff.added, ["ATLR-003"]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.reordered, [
    { id: "ATLR-002", beforeIndex: 1, afterIndex: 0 },
    { id: "ATLR-001", beforeIndex: 0, afterIndex: 1 },
  ]);
  assert.deepEqual(diff.changed, [
    { id: "ATLR-002", fields: ["dependencies"] },
    {
      id: "ATLR-001",
      fields: [
        "title",
        "goal",
        "description",
        "scope",
        "outOfScope",
        "dependencies",
        "validation",
        "completionCriteria",
        "notes",
        "priority",
        "type",
      ],
    },
  ]);
});

test("structural plan diff reports stable task identity changes as remove and add", () => {
  const before = parsePlanText(VALID_PLAN, "PLAN.md");
  const after = parsePlanText(VALID_PLAN.replaceAll("ATLR-002", "ATLR-020"), "PLAN.md");

  const diff = diffPlanStructures(
    createPlanStructureSnapshot(before),
    createPlanStructureSnapshot(after),
  );

  assert.deepEqual(diff.added, ["ATLR-020"]);
  assert.deepEqual(diff.removed, ["ATLR-002"]);
});
