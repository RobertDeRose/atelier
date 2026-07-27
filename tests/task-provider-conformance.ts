import assert from "node:assert/strict";
import type { TaskProvider } from "../packages/core/src/tasks/task-provider.ts";

export async function assertTaskProviderConformance(provider: TaskProvider): Promise<void> {
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.stablePlanTaskIds, true);
  assert.equal(capabilities.dependencyRemoval, true);
  assert.equal(capabilities.retirement, true);

  const prerequisite = await provider.create({
    planTaskId: "ATLR-CONFORMANCE-1",
    title: "Provider prerequisite",
    description: "Provider conformance prerequisite",
    acceptanceCriteria: ["Exists"],
    priority: 1,
    type: "task",
  });
  const task = await provider.create({
    planTaskId: "ATLR-CONFORMANCE-2",
    title: "Provider task; $(literal)",
    description: "Literal metacharacters: ; && >",
    acceptanceCriteria: ["Conforms"],
    priority: 1,
    type: "task",
  });

  assert.equal((await provider.get(task.id))?.planTaskId, "ATLR-CONFORMANCE-2");
  assert.equal((await provider.list()).find((candidate) => candidate.id === task.id)?.planTaskId, "ATLR-CONFORMANCE-2");

  await provider.addDependency(task.id, prerequisite.id, "blocks");
  assert.deepEqual((await provider.get(task.id))?.dependencies, [prerequisite.id]);
  await provider.removeDependency(task.id, prerequisite.id, "blocks");
  assert.deepEqual((await provider.get(task.id))?.dependencies, []);

  const retired = await provider.close(task.id, "retired by provider conformance");
  assert.equal(retired.status, "closed");
}
