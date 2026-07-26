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
export type GrantScope = "operation" | "turn" | "task" | "session" | "repository";
export type OperationRisk = "routine" | "destructive" | "external" | "unknown";

export interface RepositorySnapshot {
  repositoryId: string;
  workspaceId: string;
  vcs: "jj" | "git" | "none";
  headCommit: string;
  changeId?: string;
  operationId?: string;
  dirtyGeneration: number;
  dirtyFingerprint: string;
  indexSchemaVersion: number;
}

export interface ActionRequest {
  action: ActionKind;
  risk?: OperationRisk;
  taskId?: string;
  actor: Actor;
  repositorySnapshot?: RepositorySnapshot;
  paths?: string[];
  command?: string[];
  estimatedDurationMs?: number;
  requestedPermissions?: Permission[];
  rationale: string;
}

export interface PermissionGrant {
  id: string;
  permission: Permission;
  scope: GrantScope;
  actor: Actor;
  taskId?: string;
  repositoryId?: string;
  paths?: string[];
  commandPrefix?: string[];
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

export type ReconciliationOperation =
  | { kind: "create"; planTaskId: string; request: CreateTaskRequest }
  | { kind: "update"; planTaskId: string; providerTaskId: string; patch: TaskPatch }
  | { kind: "link"; planTaskId: string; providerTaskId: string; dependencyPlanTaskId: string; dependencyProviderTaskId: string }
  | { kind: "conflict"; planTaskId: string; reason: string };

export interface TaskReconciliation {
  planHash: string;
  operations: ReconciliationOperation[];
  created: Array<{ planTaskId: string; providerTaskId: string }>;
  applied: boolean;
  conflicts: string[];
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
  permissions: PermissionGrant[];
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
