import test from "node:test";
import assert from "node:assert/strict";
import { RepositoryStatePlanner, extractLiteralHints } from "../packages/core/src/state/repository-state-planner.ts";

const planner = new RepositoryStatePlanner();

test("repository state planner derives planning retrieval from durable objectives", () => {
  const objective = "Implement `WorkingStateBuilder` in packages/core/src/state/working-state-builder.ts and add regression tests";
  const plan = planner.plan({ mode: "plan", planObjective: objective });

  assert.equal(plan.queries.length, 1);
  assert.equal(plan.queries[0]?.purpose, "plan_objective");
  assert.equal(plan.queries[0]?.focus, "mixed");
  assert.ok(plan.queries[0]?.literalHints.includes("WorkingStateBuilder"));
  assert.ok(plan.queries[0]?.literalHints.includes("packages/core/src/state/working-state-builder.ts"));
});

test("literal hint extraction is bounded and excludes generic workflow nouns", () => {
  const hints = extractLiteralHints("Update Atelier Working State through `CodeProviderRegistry`, parse_plan, and src/core.ts", 3);
  assert.deepEqual(hints, ["CodeProviderRegistry", "parse_plan", "src/core.ts"]);
});
