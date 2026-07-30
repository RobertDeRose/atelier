import {
  taskConstraintSummary,
  type AtelierCore,
} from "../../../packages/core/src/index.ts";

export function preparationSummary(
  core: AtelierCore,
  prepared: Awaited<ReturnType<AtelierCore["execution"]["prepare"]>>,
): string {
  const first = core.parsePlan().tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.dependencies.length === 0)
    .sort((left, right) => left.task.priority - right.task.priority || left.index - right.index)[0]?.task;
  const retirements = prepared.reconciliation.operations.filter((operation) => operation.kind === "retire");
  return [
    `Plan hash: ${prepared.approval.planHash}`,
    `Provider: ${prepared.approval.provider.name}${prepared.approval.provider.version ? ` ${prepared.approval.provider.version}` : ""}`,
    `Reconciliation digest: ${prepared.approval.reconciliationDigest}`,
    `Operations: ${prepared.reconciliation.operations.length}`,
    ...prepared.reconciliation.operations.map((operation) => `- ${operation.kind}: ${operation.planTaskId}`),
    `Retirements: ${retirements.length}${retirements.length === 0 ? "" : ` (${retirements.map((operation) => operation.planTaskId).join(", ")})`}`,
    `Proposed first task: ${first === undefined ? "none" : `${first.id} — ${first.title}`}`,
    ...taskConstraintSummary(prepared.approval.taskConstraints, core.config.repositoryRoot),
  ].join("\n");
}
