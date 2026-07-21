import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanText } from "../packages/core/src/planning/plan-parser.ts";
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
