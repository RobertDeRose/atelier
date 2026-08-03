import test from "node:test";
import assert from "node:assert/strict";
import { RepositoryStatePlanner, extractLiteralHints } from "../packages/core/src/state/repository-state-planner.ts";

const planner = new RepositoryStatePlanner();

test("repository state planner derives one semantic discovery from durable objectives", () => {
  const objective = "Implement `WorkingStateBuilder` and add regression tests";
  const plan = planner.plan({ mode: "plan", planObjective: objective });

  assert.equal(plan.queries.length, 1);
  assert.equal(plan.queries[0]?.operation, "search");
  assert.equal(plan.queries[0]?.phase, "semantic_discovery");
  assert.equal(plan.queries[0]?.purpose, "plan_objective");
  assert.equal(plan.queries[0]?.focus, "mixed");
  assert.ok(plan.queries[0]?.literalHints.includes("WorkingStateBuilder"));
  assert.match(plan.queries[0]?.reason ?? "", /broad semantic discovery/i);
});

test("repository state planner merges purposes into one broad semantic phase", () => {
  const plan = planner.plan({
    mode: "plan",
    planObjective: "Trace `CodeService` retrieval",
    activeTask: {
      id: "task-1",
      title: "Trace CodeService retrieval",
      description: "Trace `CodeService` retrieval",
      acceptanceCriteria: [],
      status: "in_progress",
      priority: 0,
      type: "task",
      dependencies: [],
      labels: [],
    },
  });

  assert.equal(plan.queries.length, 1);
  assert.deepEqual(plan.queries[0]?.purposes, ["plan_objective", "active_task"]);
  assert.match(plan.explanation.join(" "), /merged 2 equivalent retrieval purposes/i);
});

test("exact symbol phases are emitted only after semantic discovery and only for unresolved identifiers", () => {
  const first = planner.plan({
    mode: "plan",
    planObjective: "Trace `CodeService` and `RepositoryStatePlanner`",
  });
  assert.deepEqual(first.queries.map((query) => query.operation), ["search"]);

  const followUp = planner.plan({
    mode: "plan",
    planObjective: "Trace `CodeService` and `RepositoryStatePlanner`",
    evidence: {
      semanticDiscoveryComplete: true,
      resolvedIdentifiers: ["CodeService"],
      unresolvedIdentifiers: ["RepositoryStatePlanner"],
      knownPaths: [],
    },
    maximumQueries: 3,
  });
  assert.deepEqual(followUp.queries.map((query) => query.operation), ["symbols"]);
  assert.equal(followUp.queries[0]?.text, "RepositoryStatePlanner");
  assert.match(followUp.queries[0]?.reason ?? "", /remained unresolved/i);
});

test("known paths produce direct-read decisions instead of semantic searches", () => {
  const path = "packages/core/src/code/service.ts";
  const plan = planner.plan({
    mode: "plan",
    planObjective: `Inspect \`${path}\``,
    evidence: { semanticDiscoveryComplete: false, resolvedIdentifiers: [], knownPaths: [path] },
  });

  assert.deepEqual(plan.queries, []);
  assert.deepEqual(plan.decisions, [{
    kind: "direct_read",
    path,
    reason: "Path is already known; read it directly instead of issuing another provider query.",
  }]);
});


test("directory scopes remain semantic filters rather than direct-read decisions", () => {
  const plan = planner.plan({
    mode: "plan",
    planObjective: "Inspect packages/core/src/code/ retrieval contracts",
  });
  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.queries[0]?.operation, "search");
  assert.ok(plan.queries[0]?.literalHints.includes("packages/core/src/code/"));
});

test("literal hint extraction is bounded and excludes generic workflow nouns", () => {
  const hints = extractLiteralHints("Update Atelier Working State through `CodeProviderRegistry`, parse_plan, and src/core.ts", 3);
  assert.deepEqual(hints, ["CodeProviderRegistry", "parse_plan", "src/core.ts"]);
});


test("literal hint and exact-symbol planning reject quoted expressions and non-symbol workflow terms", () => {
  const hints = extractLiteralHints('Add `ATELIER_PRODUCT_NAME = "Atelier"` and run `manual-acceptance` through CLI');
  assert.ok(hints.includes("ATELIER_PRODUCT_NAME"));
  assert.equal(hints.includes('ATELIER_PRODUCT_NAME = "Atelier"'), false);

  const plan = planner.plan({
    mode: "plan",
    planObjective: 'Add `ATELIER_PRODUCT_NAME = "Atelier"` and run `manual-acceptance` through CLI',
    evidence: {
      semanticDiscoveryComplete: true,
      resolvedIdentifiers: [],
      unresolvedIdentifiers: ["ATELIER_PRODUCT_NAME"],
      knownPaths: [],
    },
    maximumQueries: 8,
  });
  assert.deepEqual(plan.queries.map((query) => query.text), ["ATELIER_PRODUCT_NAME"]);
});

test("exact file-scoped planning objectives use direct reads without semantic discovery", () => {
  const first = "packages/core/src/version.ts";
  const second = "tests/version.test.ts";
  const plan = planner.plan({
    mode: "plan",
    planObjective: `Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to ${first} and add ${second} verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. Do not change release metadata or any other behavior.`,
  });

  assert.deepEqual(plan.queries, []);
  assert.deepEqual(plan.decisions.map((decision) => decision.path), [first, second]);
  assert.match(plan.explanation.join(" "), /implementation files explicitly/i);
});

test("explicit paths do not suppress discovery when the objective asks for broader impact", () => {
  const path = "packages/core/src/version.ts";
  const plan = planner.plan({
    mode: "plan",
    planObjective: `Update ${path} and determine related architecture impacts across the repository.`,
  });
  assert.equal(plan.queries[0]?.operation, "search");
});
