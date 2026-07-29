import type {
  RetrievalBudgetSnapshot,
  RetrievalDecisionRecord,
  RetrievalDiagnostic,
  RetrievalInvalidation,
  RetrievalPersistenceStatus,
  RetrievalTelemetry,
} from "./retrieval-state.ts";
import type { CodeFreshness } from "./code-identity.ts";
import type { RepositoryRevisionBinding, RetrievalRevisionBinding } from "../repository/revision-binding.ts";
import type { RepositorySnapshot } from "../repository/snapshot.ts";
export type { RepositorySnapshot } from "../repository/snapshot.ts";

export const ACTION_KINDS = [
  "read.repository",
  "write.file",
  "write.multiple_files",
  "dependency.modify",
  "repository.change.create",
  "repository.workspace.create",
  "repository.publish",
  "task.create",
  "task.update",
  "task.link",
  "task.close",
  "validation.focused",
  "validation.full_suite",
  "command.execute",
  "command.long_running",
  "network.access",
  "capability.forge",
  "capability.promote",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const PERMISSIONS = [
  "repository.read",
  "file.write",
  "file.write.outside_scope",
  "dependency.modify",
  "repository.change.create",
  "repository.workspace.create",
  "repository.publish",
  "task.create",
  "task.update",
  "task.link",
  "task.close",
  "validation.focused",
  "validation.full_suite",
  "command.execute",
  "command.long_running",
  "network.access",
  "capability.forge",
  "capability.promote",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Actor = "user" | "agent" | "tool" | "system";
export type WorkflowMode = "investigate" | "plan" | "act";
export type GrantScope = "operation" | "task" | "repository";
export type ExecutionBoundary = "typed" | "sandboxed" | "unconfined";
export type OperationRisk = "routine" | "destructive" | "external" | "unknown";


export interface ActionRequest {
  action: ActionKind;
  risk?: OperationRisk;
  taskId?: string;
  actor: Actor;
  repositorySnapshot?: RepositorySnapshot;
  paths?: string[];
  validationName?: string;
  validationNames?: string[];
  command?: string[];
  estimatedDurationMs?: number;
  requestedPermissions?: Permission[];
  boundary?: ExecutionBoundary;
  rationale: string;
}

export interface PermissionGrant {
  id: string;
  executionGrantId?: string;
  permission: Permission;
  scope: GrantScope;
  actor: Actor;
  taskId?: string;
  repositoryId?: string;
  paths?: string[];
  validationNames?: string[];
  reason: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface PolicyDecision {
  id: string;
  result: "allow" | "deny" | "require_approval";
  action: ActionKind;
  requiredPermission?: Permission;
  matchedRules: string[];
  missingPermissions: Permission[];
  constraints: string[];
  reason: string;
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "closed" | "deferred" | "unknown";
export type TaskType = "bug" | "feature" | "task" | "epic" | "chore" | "unknown";

export interface TaskRecord {
  id: string;
  planTaskId?: string;
  title: string;
  description: string;
  design?: string;
  notes?: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  priority: number;
  type: TaskType;
  dependencies: string[];
  labels: string[];
  assignee?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface CreateTaskRequest {
  planTaskId: string;
  title: string;
  description: string;
  design?: string;
  notes?: string;
  acceptanceCriteria: string[];
  priority: number;
  type: TaskType;
  labels?: string[];
}

export interface TaskPatch {
  title?: string;
  description?: string;
  design?: string;
  notes?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  type?: TaskType;
  status?: TaskStatus;
}

export interface TaskProviderStatus {
  provider: string;
  available: boolean;
  initialized: boolean;
  version?: string;
  reason?: string;
}

export interface TaskExecutionContract {
  /** Repository-relative source paths or directories this task may modify. */
  writePaths: string[];
  /** Dependency manifests still require a separate dependency capability. */
  allowDependencyChanges: boolean;
  /** Exact configured validation names this task may run. */
  validations: string[];
  /** Full-suite validation is never implied by a focused validation. */
  allowFullSuite: boolean;
  /** Permit one local commit/change containing only writePaths. */
  allowLocalChange: boolean;
}

export interface PlanTask {
  id: string;
  title: string;
  goal: string;
  description: string;
  scope: string[];
  outOfScope: string[];
  dependencies: string[];
  validation: string[];
  completionCriteria: string[];
  notes: string[];
  priority: number;
  type: TaskType;
  execution?: TaskExecutionContract;
  source: {
    startLine: number;
    endLine: number;
  };
}

export interface PlanDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  line?: number;
  taskId?: string;
}

export interface ParsedPlan {
  path: string;
  title: string;
  hash: string;
  tasks: PlanTask[];
  diagnostics: PlanDiagnostic[];
}

export const PLAN_STRUCTURAL_FIELDS = [
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
  "execution",
] as const;

export type PlanStructuralField = (typeof PLAN_STRUCTURAL_FIELDS)[number];

export interface PlanStructureTaskSnapshot {
  id: string;
  fieldHashes: Record<PlanStructuralField, string>;
}

export interface PlanStructureSnapshot {
  order: string[];
  tasks: PlanStructureTaskSnapshot[];
}

export interface PlanStructuralDiff {
  added: string[];
  removed: string[];
  reordered: Array<{ id: string; beforeIndex: number; afterIndex: number }>;
  changed: Array<{ id: string; fields: PlanStructuralField[] }>;
}

export type WorkflowRunStatus = "active" | "completed" | "cancelled" | "failed";
export type WorkflowCheckpoint =
  | "drafting"
  | "review_pending"
  | "reviewing"
  | "reviewed"
  | "reconciling"
  | "approved"
  | "executing"
  | "paused"
  | "validating"
  | "completed"
  | "cancelled"
  | "failed";

export interface WorkflowRun {
  id: string;
  status: WorkflowRunStatus;
  checkpoint: WorkflowCheckpoint;
  objective: string;
  planPath: string;
  currentManualEditId?: string;
  reviewedPlanHash?: string;
  startedAt: string;
  updatedAt: string;
}

export type ManualEditStatus = "started" | "completed" | "interrupted" | "failed";
export type ManualEditDriftStatus = "none" | "repository_changed" | "workspace_changed";

export interface ManualEditEditor {
  executable: string;
  args: string[];
  source?: "atlr" | "pi" | "VISUAL" | "EDITOR" | "fallback";
}

export interface ManualEdit {
  id: string;
  workflowRunId: string;
  purpose: "plan_review";
  status: ManualEditStatus;
  planPath: string;
  editor?: ManualEditEditor;
  beforeHash: string;
  beforeStructure: PlanStructureSnapshot;
  beforeRepositorySnapshot: RepositorySnapshot;
  beforeSourceFingerprint: string;
  beforeSourcePaths: string[];
  afterHash?: string;
  afterStructure?: PlanStructureSnapshot;
  afterRepositorySnapshot?: RepositorySnapshot;
  afterSourceFingerprint?: string;
  afterSourcePaths?: string[];
  changed?: boolean;
  changedPaths: string[];
  diagnostics?: PlanDiagnostic[];
  structuralDiff?: PlanStructuralDiff;
  driftStatus: ManualEditDriftStatus;
  ambiguous: boolean;
  accepted: boolean;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface TaskProviderIdentity {
  name: string;
  version?: string;
}

export interface TaskProviderCapabilities {
  stablePlanTaskIds: boolean;
  dependencyRemoval: boolean;
  retirement: boolean;
}

export interface ReconciliationFieldChange {
  field: keyof TaskPatch;
  before: unknown;
  after: unknown;
}

interface ReconciliationOperationBase {
  operationId: string;
  planTaskId: string;
}

export type ReconciliationOperation =
  | (ReconciliationOperationBase & { kind: "create"; request: CreateTaskRequest })
  | (ReconciliationOperationBase & { kind: "adopt"; providerTaskId: string })
  | (ReconciliationOperationBase & {
      kind: "update";
      providerTaskId: string;
      patch: TaskPatch;
      changes: ReconciliationFieldChange[];
    })
  | (ReconciliationOperationBase & {
      kind: "link";
      providerTaskId?: string;
      dependencyPlanTaskId: string;
      dependencyProviderTaskId?: string;
    })
  | (ReconciliationOperationBase & {
      kind: "unlink";
      providerTaskId: string;
      dependencyPlanTaskId: string;
      dependencyProviderTaskId: string;
    })
  | (ReconciliationOperationBase & { kind: "retire"; providerTaskId: string })
  | (ReconciliationOperationBase & { kind: "conflict"; reason: string });

export type ReconciliationOperationStatus = "started" | "completed" | "failed";

export interface ReconciliationOperationCheckpoint {
  reconciliationDigest: string;
  operationId: string;
  provider: TaskProviderIdentity;
  planHash: string;
  status: ReconciliationOperationStatus;
  error?: string;
  updatedAt: string;
}

export interface TaskReconciliation {
  planHash: string;
  provider: TaskProviderIdentity;
  digest: string;
  operations: ReconciliationOperation[];
  unchanged: string[];
  created: Array<{ planTaskId: string; providerTaskId: string }>;
  applied: boolean;
  conflicts: string[];
}

export type PlanApprovalStatus = "prepared" | "accepted" | "approved" | "rejected" | "invalidated" | "cancelled";

export interface ExecutionCapability {
  planTaskId: string;
  permission: Permission;
  paths?: string[];
  validationNames?: string[];
  reason: string;
}

export interface PlanApproval {
  id: string;
  status: PlanApprovalStatus;
  planPath: string;
  planHash: string;
  reconciliationDigest: string;
  provider: TaskProviderIdentity;
  workspaceId: string;
  repositoryId: string;
  repositorySnapshot: RepositorySnapshot;
  repositoryBindings: RepositoryRevisionBinding[];
  retrievalBindings: RetrievalRevisionBinding[];
  capabilities: ExecutionCapability[];
  capabilityDigest: string;
  preparedAt: string;
  decidedAt?: string;
  invalidationReason?: string;
}

export type ReconciliationTransactionStatus = "prepared" | "applying" | "applied" | "failed" | "cancelled";

export interface ReconciliationTransaction {
  id: string;
  planApprovalId: string;
  status: ReconciliationTransactionStatus;
  planHash: string;
  reconciliationDigest: string;
  provider: TaskProviderIdentity;
  preview: TaskReconciliation;
  preparedAt: string;
  updatedAt: string;
  error?: string;
}

export type ExecutionGrantStatus = "active" | "revoked" | "invalidated";


export interface ExecutionPause {
  executionGrantId: string;
  taskId: string;
  reason: string;
  pausedAt: string;
}

export interface ExecutionGrant {
  id: string;
  status: ExecutionGrantStatus;
  planApprovalId: string;
  reconciliationTransactionId: string;
  planHash: string;
  reconciliationDigest: string;
  provider: TaskProviderIdentity;
  workspaceId: string;
  repositoryId: string;
  repositorySnapshot: RepositorySnapshot;
  repositoryBindings: RepositoryRevisionBinding[];
  retrievalBindings: RetrievalRevisionBinding[];
  /** Digest of the full approved multi-task capability projection. */
  approvalCapabilityDigest: string;
  /** Digest of capabilities installed for this one active plan task. */
  capabilityDigest: string;
  taskId: string;
  planTaskId: string;
  issuedAt: string;
  revokedAt?: string;
  invalidationReason?: string;
}

export interface ExecutionPreparation {
  approval: PlanApproval;
  transaction: ReconciliationTransaction;
  reconciliation: TaskReconciliation;
}

export interface ExecutionTransition extends ExecutionPreparation {
  task?: TaskRecord;
  executionGrant?: ExecutionGrant;
}

export interface TaskStartTransition {
  task: TaskRecord;
  transaction: ReconciliationTransaction;
  executionGrant: ExecutionGrant;
}

export type ExecutionEvidenceStatus = "started" | "succeeded" | "failed" | "interrupted";

export interface ExecutionEvidence {
  id: string;
  toolCallId: string;
  toolName: string;
  action: ActionKind;
  status: ExecutionEvidenceStatus;
  taskId: string;
  executionGrantId: string;
  policyDecisionId: string;
  permissionGrantId?: string;
  beforeSnapshot: RepositorySnapshot;
  afterSnapshot?: RepositorySnapshot;
  requestedPaths: string[];
  beforeChangedPaths: string[];
  changedPaths: string[];
  newlyChangedPaths: string[];
  furtherModifiedPaths: string[];
  removedPaths: string[];
  unchangedExistingDirtyPaths: string[];
  pathFingerprintsBefore: Record<string, string>;
  pathFingerprintsAfter?: Record<string, string>;
  observedMutation: boolean;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface FinalDiffPreview {
  taskId: string;
  executionGrantId: string;
  baselineHeadCommit: string;
  changedPaths: string[];
  diff: string;
  diffHash: string;
}

export interface FinalDiffReview {
  id: string;
  taskId: string;
  executionGrantId: string;
  baselineHeadCommit: string;
  snapshot: RepositorySnapshot;
  changedPaths: string[];
  diffHash: string;
  reviewedAt: string;
}

export interface FocusedValidationSelection {
  id: string;
  taskId: string;
  executionGrantId: string;
  planHash: string;
  reconciliationDigest: string;
  snapshot: RepositorySnapshot;
  changedPaths: string[];
  changedSymbols: string[];
  selected: Array<{ name: string; reason: string; required: boolean }>;
  noMatch: boolean;
  createdAt: string;
}

export interface ValidationEvidenceRecord {
  id: string;
  name: string;
  command: string[];
  taskId?: string;
  executionGrantId?: string;
  planHash?: string;
  selectionId?: string;
  snapshotFingerprint: string;
  environmentFingerprint?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  status: "passed" | "failed" | "interrupted";
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ValidationEvidenceSummary {
  id: string;
  name: string;
  status: ValidationEvidenceRecord["status"];
  durationMs: number;
  snapshotFingerprint: string;
  stale: boolean;
  staleReason?: string;
}

export type TaskClosureBlockerCode =
  | "validation_selection_missing"
  | "validation_no_required_match"
  | "validation_not_configured"
  | "validation_evidence_missing"
  | "validation_evidence_stale"
  | "validation_failed"
  | "diff_review_missing"
  | "local_change_missing"
  | "repository_dirty";

export interface TaskClosureBlocker {
  code: TaskClosureBlockerCode;
  detail: string;
  names?: string[];
}

export interface TaskClosureReadiness {
  ready: boolean;
  blockers: TaskClosureBlocker[];
  required: string[];
  missing: string[];
  stale: string[];
  failed: string[];
  validationReady?: boolean;
  finalDiffReviewed?: boolean;
  localChangeCreated?: boolean;
  repositoryStateAcceptable?: boolean;
  reason: string;
}

export interface LedgerEvent<TPayload = unknown> {
  id: string;
  kind: string;
  occurredAt: string;
  actor: Actor;
  taskId?: string;
  repositorySnapshot?: RepositorySnapshot;
  payload: TPayload;
}

export interface WorkingStateRetrievalEvidence {
  provider: string;
  providerInstance: string;
  workspaceId: string;
  repositoryId: string;
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  queryDigests: string[];
  retrievalMethods: string[];
  freshness: CodeFreshness;
}

export interface WorkingStateRetrievalSession {
  id: string;
  inventory: WorkingStateRetrievalEvidence[];
  knownPaths: string[];
  resolvedSymbols: string[];
  unresolvedSymbols: string[];
  freshness: CodeFreshness;
  bindings: RetrievalRevisionBinding[];
  budget: RetrievalBudgetSnapshot;
  telemetry: RetrievalTelemetry;
  persistence: RetrievalPersistenceStatus;
  diagnostics: RetrievalDiagnostic[];
  invalidations: RetrievalInvalidation[];
  decisions: RetrievalDecisionRecord[];
}

export interface WorkingState {
  stateId: string;
  generatedAt: string;
  snapshot: RepositorySnapshot;
  mode: WorkflowMode;
  planObjective?: string;
  activeTask?: TaskRecord;
  taskSelection: {
    source: "explicit" | "resumed" | "ready" | "none";
    rationale: string;
  };
  readyTasks: TaskRecord[];
  taskDependencies: TaskRecord[];
  taskBlockers: TaskRecord[];
  approvedPlanHash?: string;
  planTask?: PlanTask;
  executionGrant?: ExecutionGrant;
  workflowCheckpoint?: WorkflowCheckpoint;
  planApproval?: PlanApproval;
  reconciliationTransaction?: ReconciliationTransaction;
  permissions: PermissionGrant[];
  executionEvidence: ExecutionEvidence[];
  focusedValidationSelections: FocusedValidationSelection[];
  currentValidationEvidence: ValidationEvidenceSummary[];
  staleValidationEvidence: ValidationEvidenceSummary[];
  taskClosure: TaskClosureReadiness;
  finalDiffReview?: FinalDiffReview;
  nextAction: string;
  corrections: LedgerEvent[];
  findings: LedgerEvent[];
  manualEdits: LedgerEvent[];
  recentEvents: LedgerEvent[];
  omissions: string[];
  retrievalQueries: Array<{
    purpose: "plan_objective" | "reviewed_plan" | "active_task" | "task_scope";
    text: string;
    focus: "source" | "tests" | "docs" | "all" | "mixed";
    literalHints: string[];
    resultCount: number;
    degraded: boolean;
    warnings: string[];
  }>;
  retrievalSession?: WorkingStateRetrievalSession;
  codeEvidence: Array<{
    provider: string;
    repositoryId: string;
    path: string;
    language?: string;
    symbol?: string;
    startLine?: number;
    endLine?: number;
    preview?: string;
    queryPurpose: "plan_objective" | "reviewed_plan" | "active_task" | "task_scope";
    retrievalMethods: Array<"auto" | "lexical" | "semantic" | "hybrid">;
    degraded: boolean;
    warnings: string[];
    indexState: "missing" | "building" | "ready" | "stale" | "failed" | "unknown";
  }>;
  validationEvidence: Array<{ id: string; name: string; status: "passed" | "failed" | "interrupted"; durationMs: number }>;
  retrievalExplanation: string[];
}
