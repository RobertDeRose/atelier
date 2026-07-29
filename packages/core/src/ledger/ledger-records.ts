import type {
  Actor,
  ExecutionGrant,
  PermissionGrant,
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

export interface PermissionRow {
  id: string;
  execution_grant_id: string | null;
  permission: PermissionGrant["permission"];
  scope: PermissionGrant["scope"];
  actor: Actor;
  task_id: string | null;
  repository_id: string | null;
  paths_json: string | null;
  validation_names_json: string | null;
  command_prefix_json: string | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const LEGACY_CAPABILITY_DIGEST = "legacy-capability-bundle-unsupported";

export function normalizePlanApproval(record: string): PlanApproval {
  const parsed = JSON.parse(record) as PlanApproval & Partial<PlanApproval>;
  return {
    ...parsed,
    repositoryBindings: Array.isArray(parsed.repositoryBindings)
      ? parsed.repositoryBindings
      : [repositoryRevisionBinding(parsed.repositoryId, parsed.repositorySnapshot)],
    retrievalBindings: Array.isArray(parsed.retrievalBindings) ? parsed.retrievalBindings : [],
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    capabilityDigest: typeof parsed.capabilityDigest === "string"
      ? parsed.capabilityDigest
      : LEGACY_CAPABILITY_DIGEST,
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
    approvalCapabilityDigest: typeof parsed.approvalCapabilityDigest === "string"
      ? parsed.approvalCapabilityDigest
      : LEGACY_CAPABILITY_DIGEST,
    capabilityDigest: typeof parsed.capabilityDigest === "string"
      ? parsed.capabilityDigest
      : LEGACY_CAPABILITY_DIGEST,
  };
}

export function validatePersistenceLimits(limits: RetrievalPersistenceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
}
