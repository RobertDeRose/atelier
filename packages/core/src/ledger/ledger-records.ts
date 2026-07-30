import type {
  Actor,
  ExecutionGrant,
  PlanApproval,
} from "../domain/types.ts";
import { repositoryRevisionBinding } from "../repository/revision-binding.ts";
import type { RetrievalPersistenceLimits } from "../code/retrieval.ts";

export interface EventRow {
  id: string;
  kind: string;
  occurred_at: string;
  actor: Actor;
  task_id: string | null;
  repository_snapshot_json: string | null;
  payload_json: string;
}

export interface WorkflowRunRow {
  record_json: string;
}

export interface ManualEditRow {
  record_json: string;
}


const LEGACY_CONSTRAINT_DIGEST = "legacy-permission-bundle-unsupported";

export function normalizePlanApproval(record: string): PlanApproval {
  const parsed = JSON.parse(record) as PlanApproval & Partial<PlanApproval>;
  return {
    ...parsed,
    repositoryBindings: Array.isArray(parsed.repositoryBindings)
      ? parsed.repositoryBindings
      : [repositoryRevisionBinding(parsed.repositoryId, parsed.repositorySnapshot)],
    retrievalBindings: Array.isArray(parsed.retrievalBindings) ? parsed.retrievalBindings : [],
    taskConstraints: Array.isArray((parsed as any).taskConstraints) ? (parsed as any).taskConstraints : [],
    constraintDigest: typeof (parsed as any).constraintDigest === "string"
      ? (parsed as any).constraintDigest
      : LEGACY_CONSTRAINT_DIGEST,
  };
}

export function normalizeExecutionGrant(record: string): ExecutionGrant {
  const parsed = JSON.parse(record) as ExecutionGrant & Partial<ExecutionGrant>;
  return {
    ...parsed,
    repositoryBindings: Array.isArray(parsed.repositoryBindings)
      ? parsed.repositoryBindings
      : [repositoryRevisionBinding(parsed.repositoryId, parsed.repositorySnapshot)],
    retrievalBindings: Array.isArray(parsed.retrievalBindings) ? parsed.retrievalBindings : [],
    approvalConstraintDigest: typeof (parsed as any).approvalConstraintDigest === "string"
      ? (parsed as any).approvalConstraintDigest
      : LEGACY_CONSTRAINT_DIGEST,
    constraintDigest: typeof (parsed as any).constraintDigest === "string"
      ? (parsed as any).constraintDigest
      : LEGACY_CONSTRAINT_DIGEST,
  };
}

export function validatePersistenceLimits(limits: RetrievalPersistenceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
}
