import type {
  ParsedPlan,
  PlanStructuralDiff,
  PlanStructuralField,
  PlanStructureSnapshot,
  PlanStructureTaskSnapshot,
  PlanTask,
} from "../domain/types.ts";
import { PLAN_STRUCTURAL_FIELDS } from "../domain/types.ts";
import { sha256 } from "../util/hash.ts";

function fieldValue(task: PlanTask, field: PlanStructuralField): unknown {
  return task[field];
}

function taskSnapshot(task: PlanTask): PlanStructureTaskSnapshot {
  const fieldHashes = Object.fromEntries(
    PLAN_STRUCTURAL_FIELDS.map((field) => [field, sha256(JSON.stringify(fieldValue(task, field)) ?? "undefined")]),
  ) as Record<PlanStructuralField, string>;
  return { id: task.id, fieldHashes };
}

/**
 * Capture only stable task identity, order, and fixed-size field hashes.
 * Full plan text remains in the plan document rather than the ledger.
 */
export function createPlanStructureSnapshot(
  plan: Pick<ParsedPlan, "tasks">,
): PlanStructureSnapshot {
  return {
    order: plan.tasks.map((task) => task.id),
    tasks: plan.tasks.map(taskSnapshot),
  };
}

export function diffPlanStructures(
  before: PlanStructureSnapshot,
  after: PlanStructureSnapshot,
): PlanStructuralDiff {
  const beforeById = new Map(before.tasks.map((task) => [task.id, task]));
  const afterById = new Map(after.tasks.map((task) => [task.id, task]));
  const added = after.order.filter((id) => !beforeById.has(id));
  const removed = before.order.filter((id) => !afterById.has(id));

  const commonBefore = before.order.filter((id) => afterById.has(id));
  const commonAfter = after.order.filter((id) => beforeById.has(id));
  const commonBeforeIndex = new Map(commonBefore.map((id, index) => [id, index]));
  const reordered = commonAfter.flatMap((id, afterIndex) => {
    const beforeIndex = commonBeforeIndex.get(id);
    return beforeIndex === undefined || beforeIndex === afterIndex
      ? []
      : [{ id, beforeIndex, afterIndex }];
  });

  const changed = after.order.flatMap((id) => {
    const previous = beforeById.get(id);
    const current = afterById.get(id);
    if (previous === undefined || current === undefined) return [];
    const fields = PLAN_STRUCTURAL_FIELDS.filter(
      (field) => previous.fieldHashes[field] !== current.fieldHashes[field],
    );
    return fields.length === 0 ? [] : [{ id, fields: [...fields] }];
  });

  return { added, removed, reordered, changed };
}
