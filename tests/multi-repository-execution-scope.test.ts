import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskExecutionScope } from "../packages/core/src/planning/task-execution-scope.ts";

test("task execution contracts support repository-qualified paths without broadening other roots", () => {
  const task = { id: "T", execution: { writePaths: ["primary::src/a.ts", "docs::docs/b.md"], allowDependencyChanges: false, validations: [], allowFullSuite: false, allowLocalChange: true } } as any;
  const scope = deriveTaskExecutionScope(task, "/workspace/primary", [], { repositoryRoots: { primary: "/workspace/primary", docs: "/workspace/docs" }, primaryRepositoryId: "primary" });
  assert.deepEqual(scope.writePaths, ["/workspace/docs/docs/b.md", "/workspace/primary/src/a.ts"]);
  assert.throws(() => deriveTaskExecutionScope({ ...task, execution: { ...task.execution, writePaths: ["missing::src/x.ts"] } }, "/workspace/primary", [], { repositoryRoots: { primary: "/workspace/primary" }, primaryRepositoryId: "primary" }), /unknown workspace repository/);
});
