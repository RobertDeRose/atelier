import type {
  LedgerEvent,
  RepositorySnapshot,
  TaskRecord,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { RepositoryProvider } from "../repository/repository-provider.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";

export type DstackLifecyclePhase = "plan" | "start" | "implement" | "review" | "audit" | "pause" | "recovery" | "close";
export type DstackLifecycleStatus = "idle" | "active" | "implementing" | "reviewing" | "paused" | "recovery_required" | "completed" | "cancelled";

export interface DstackFeatureMetadata {
  featureSlug?: string;
  featureName?: string;
  designPath?: string;
  implementedPath?: string;
  baseBranch?: string;
  workflowKind?: string;
}

export interface DstackFeatureInspection {
  feature: TaskRecord;
  children: TaskRecord[];
  blockers: TaskRecord[];
  missingDependencies: string[];
  readyTasks: TaskRecord[];
  metadata: DstackFeatureMetadata;
  status: DstackLifecycleStatus;
  phase: DstackLifecyclePhase;
  nextAction: string;
  activeTaskId?: string;
  snapshot: RepositorySnapshot;
}

export interface DstackLifecycleTransition {
  action: "start" | "implement" | "review" | "pause" | "recovery" | "close";
  before: DstackFeatureInspection;
  after: DstackFeatureInspection;
  snapshot: RepositorySnapshot;
  event: LedgerEvent;
}

export interface DstackImplementationPreparation {
  feature: DstackFeatureInspection;
  task: TaskRecord;
  readyTasks: TaskRecord[];
  /** Task mutation remains behind the existing exact execution-grant flow. */
  requiresExplicitExecutionGrant: true;
}

export interface DstackAudit {
  inspection: DstackFeatureInspection;
  closeReady: boolean;
  closeBlockers: string[];
}

export interface DstackLifecycleCoordinatorOptions {
  provider: TaskProvider;
  ledger: SqliteLedger;
  repository: RepositoryProvider;
  /** Existing Core execution controls remain authoritative for task mutation. */
  pauseExecution?: (reason: string) => unknown | Promise<unknown>;
  resumeExecution?: () => unknown | Promise<unknown>;
}

export interface DstackFeatureCloseOptions {
  confirmed: boolean;
  reason: string;
  reviewComplete: boolean;
  gatesComplete: boolean;
}

const FEATURE_STATE_KEY = "dstack.feature.id";
const STATUS_STATE_KEY = "dstack.lifecycle.status";
const PHASE_STATE_KEY = "dstack.lifecycle.phase";
const REASON_STATE_KEY = "dstack.lifecycle.reason";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataFor(task: TaskRecord): DstackFeatureMetadata {
  const raw = asRecord(task.raw);
  const metadata = asRecord(raw?.metadata) ?? asRecord(raw?.meta);
  const source = metadata ?? raw;
  const featureSlug = firstString(source, ["feature_slug", "featureSlug", "slug"]);
  const featureName = firstString(source, ["feature_name", "featureName"]);
  const designPath = firstString(source, ["design_path", "designPath", "spec_id"]);
  const implementedPath = firstString(source, ["implemented_path", "implementedPath"]);
  const baseBranch = firstString(source, ["base_branch", "baseBranch"]);
  const workflowKind = firstString(source, ["workflow_kind", "workflowKind"]);
  return {
    ...(featureSlug === undefined ? {} : { featureSlug }),
    ...(featureName === undefined ? {} : { featureName }),
    ...(designPath === undefined ? {} : { designPath }),
    ...(implementedPath === undefined ? {} : { implementedPath }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(workflowKind === undefined ? {} : { workflowKind }),
  };
}

function parentId(task: TaskRecord): string | undefined {
  if (task.parentId !== undefined) return task.parentId;
  const raw = asRecord(task.raw);
  return firstString(raw, ["parent", "parent_id", "parentId"]);
}

function isFeatureRoot(task: TaskRecord): boolean {
  return task.type === "epic" || task.labels.includes("workflow:feature") || task.labels.includes("workflow:feature-lifecycle");
}

function terminal(task: TaskRecord): boolean {
  return task.status === "closed" || task.status === "deferred";
}

function sortTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

function phaseFor(status: DstackLifecycleStatus): DstackLifecyclePhase {
  switch (status) {
    case "active": return "start";
    case "implementing": return "implement";
    case "reviewing": return "review";
    case "paused": return "pause";
    case "recovery_required": return "recovery";
    case "completed":
    case "cancelled": return "close";
    case "idle": return "plan";
  }
}

function nextActionFor(input: {
  status: DstackLifecycleStatus;
  featureId: string;
  blockers: readonly TaskRecord[];
  missingDependencies: readonly string[];
  readyTasks: readonly TaskRecord[];
  activeTaskId?: string;
}): string {
  if (input.status === "completed") return "Feature is complete; review the delivered record.";
  if (input.status === "cancelled") return "Feature is cancelled; reopen it explicitly in Beads if work should continue.";
  if (input.status === "paused") return `Resume feature ${input.featureId} explicitly, or cancel it; no mutation will start automatically.`;
  if (input.status === "recovery_required") return `Recover feature ${input.featureId} explicitly after inspecting its snapshot and task state.`;
  if (input.status === "reviewing") return `Audit feature ${input.featureId}, then close it only with current review and repository-check evidence.`;
  if (input.status === "implementing") {
    if (input.activeTaskId !== undefined) return `Continue bounded implementation of task ${input.activeTaskId}; pause or close it explicitly.`;
    const task = input.readyTasks[0];
    return task === undefined
      ? "Resolve implementation blockers or reconcile the feature graph before selecting another task."
      : `Activate ready task ${task.id} with an explicit execution grant before mutation.`;
  }
  if (input.blockers.length > 0 || input.missingDependencies.length > 0) return `Resolve feature ${input.featureId} blockers before starting implementation.`;
  if (input.status === "active") {
    const task = input.readyTasks[0];
    return task === undefined ? "Reconcile the feature graph; no ready implementation task is available." : `Prepare ready task ${task.id} for explicit implementation.`;
  }
  return `Start feature ${input.featureId} explicitly after reviewing its design, scope, and repository checks.`;
}

function statusFor(ledger: SqliteLedger, feature: TaskRecord): DstackLifecycleStatus {
  const currentFeature = ledger.getState<string>(FEATURE_STATE_KEY);
  if (feature.status === "closed" || feature.status === "deferred") return "completed";
  if (currentFeature === feature.id) {
    const stored = ledger.getState<DstackLifecycleStatus>(STATUS_STATE_KEY);
    if (stored !== undefined) {
      // Beads remains live authority. A provider status that contradicts a
      // durable lifecycle transition requires recovery rather than inference.
      if (stored === "completed") return "recovery_required";
      if (!["idle", "completed", "cancelled"].includes(stored) && feature.status === "open") return "recovery_required";
      return stored;
    }
  }
  return feature.status === "in_progress" ? "active" : "idle";
}

export class DstackLifecycleCoordinator {
  private readonly provider: TaskProvider;
  private readonly ledger: SqliteLedger;
  private readonly repository: RepositoryProvider;
  private readonly pauseExecution: ((reason: string) => unknown | Promise<unknown>) | undefined;
  private readonly resumeExecution: (() => unknown | Promise<unknown>) | undefined;

  constructor(options: DstackLifecycleCoordinatorOptions) {
    this.provider = options.provider;
    this.ledger = options.ledger;
    this.repository = options.repository;
    this.pauseExecution = options.pauseExecution;
    this.resumeExecution = options.resumeExecution;
  }

  async inspectFeature(featureId: string): Promise<DstackFeatureInspection> {
    const normalizedId = featureId.trim();
    if (!normalizedId) throw new Error("A dstack feature id is required.");
    const allTasks = await this.provider.list();
    const feature = allTasks.find((task) => task.id === normalizedId);
    if (feature === undefined) throw new Error(`Dstack feature ${normalizedId} was not found.`);
    if (!isFeatureRoot(feature)) {
      throw new Error(`Task ${feature.id} is not a dstack feature root; feature roots must be epics or workflow:feature issues.`);
    }
    const children = sortTasks(allTasks.filter((task) => parentId(task) === feature.id));
    const byId = new Map(allTasks.map((task) => [task.id, task]));
    // Feature activation is blocked by root dependencies. Child dependencies
    // are evaluated independently when selecting the next implementation task.
    const dependencyIds = [...new Set(feature.dependencies)];
    const missingDependencies = dependencyIds.filter((id) => !byId.has(id));
    const blockers = sortTasks(dependencyIds
      .map((id) => byId.get(id))
      .filter((task): task is TaskRecord => task !== undefined && !terminal(task)));
    const readyTasks = children.filter((task) =>
      task.type !== "epic"
      && (task.status === "open" || task.status === "in_progress")
      && task.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === "closed"),
    );
    const sortedReadyTasks = sortTasks(readyTasks);
    const status = statusFor(this.ledger, feature);
    const activeGrant = this.ledger.getActiveExecutionGrant();
    const activeTaskId = activeGrant?.taskId;
    return {
      feature,
      children,
      blockers,
      missingDependencies,
      readyTasks: sortedReadyTasks,
      metadata: metadataFor(feature),
      status,
      phase: phaseFor(status),
      nextAction: nextActionFor({ status, featureId: feature.id, blockers, missingDependencies, readyTasks: sortedReadyTasks, ...(activeTaskId === undefined ? {} : { activeTaskId }) }),
      ...(activeTaskId === undefined ? {} : { activeTaskId }),
      snapshot: this.repository.snapshot(),
    };
  }

  async startFeature(featureId: string, confirmed: boolean): Promise<DstackLifecycleTransition | undefined> {
    const before = await this.inspectFeature(featureId);
    if (before.status === "paused" || before.status === "recovery_required") {
      throw new Error(`Feature ${before.feature.id} requires an explicit recovery decision before it can start.`);
    }
    this.requireStartable(before);
    if (!confirmed) return undefined;
    if (before.feature.status === "open") {
      await this.provider.claim(before.feature.id);
    }
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, "active", "start", {
      kind: "dstack.feature.started",
      actor: "user",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: {
        featureId: before.feature.id,
        featureSlug: before.metadata.featureSlug,
        childCount: before.children.length,
      },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "start", before, after, snapshot, event };
  }

  async prepareImplementation(featureId: string, requestedTaskId?: string): Promise<DstackImplementationPreparation> {
    const feature = await this.inspectFeature(featureId);
    if (feature.status !== "active" && feature.status !== "implementing") {
      throw new Error(`Feature ${feature.feature.id} is not active; explicitly start it before implementation.`);
    }
    if (feature.blockers.length > 0 || feature.missingDependencies.length > 0) {
      throw new Error(this.blockerReason(feature));
    }
    const task = requestedTaskId === undefined
      ? feature.readyTasks[0]
      : feature.readyTasks.find((candidate) => candidate.id === requestedTaskId);
    if (task === undefined) {
      throw new Error(requestedTaskId === undefined
        ? `Feature ${feature.feature.id} has no ready implementation task.`
        : `Implementation task ${requestedTaskId} is not ready within feature ${feature.feature.id}.`);
    }
    const activeGrant = this.ledger.getActiveExecutionGrant();
    if (activeGrant !== undefined && activeGrant.taskId !== task.id) {
      throw new Error(`Execution grant ${activeGrant.id} is active for task ${activeGrant.taskId}; finish or pause it before selecting ${task.id}.`);
    }
    if (task.status === "in_progress" && activeGrant?.taskId !== task.id) {
      throw new Error(`Implementation task ${task.id} is already in progress without an Atelier execution grant.`);
    }
    if (feature.status === "active") {
      this.persistLifecycle(feature.feature.id, "implementing", "implement", {
        kind: "dstack.feature.implementation_prepared",
        actor: "user",
        taskId: task.id,
        repositorySnapshot: feature.snapshot,
        payload: { featureId: feature.feature.id, taskId: task.id, requiresExplicitExecutionGrant: true },
      });
    }
    return {
      feature: await this.inspectFeature(feature.feature.id),
      task,
      readyTasks: feature.readyTasks,
      requiresExplicitExecutionGrant: true,
    };
  }

  async pauseFeature(featureId: string, reason: string): Promise<DstackLifecycleTransition | undefined> {
    const before = await this.inspectFeature(featureId);
    if (!["active", "implementing", "reviewing"].includes(before.status)) {
      throw new Error(`Feature ${before.feature.id} cannot pause from ${before.status}.`);
    }
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("Pausing a dstack feature requires an explicit reason.");
    const activeGrant = this.ledger.getActiveExecutionGrant();
    if (activeGrant !== undefined && !before.children.some((task) => task.id === activeGrant.taskId)) {
      throw new Error(`Execution grant ${activeGrant.id} belongs to task ${activeGrant.taskId}, not feature ${before.feature.id}.`);
    }
    const pausedExecution = await this.pauseExecution?.(normalizedReason);
    if (activeGrant !== undefined && pausedExecution === undefined) {
      throw new Error(`Execution grant ${activeGrant.id} could not be paused.`);
    }
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, "paused", "pause", {
      kind: "dstack.feature.paused",
      actor: "user",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: { featureId: before.feature.id, reason: normalizedReason },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "pause", before, after, snapshot, event };
  }

  async markRecoveryRequired(featureId: string, reason: string): Promise<DstackLifecycleTransition> {
    const before = await this.inspectFeature(featureId);
    if (["completed", "cancelled"].includes(before.status)) {
      throw new Error(`Completed feature ${before.feature.id} cannot enter recovery.`);
    }
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("Recovery state requires an explicit reason.");
    const activeGrant = this.ledger.getActiveExecutionGrant();
    if (activeGrant !== undefined) {
      if (!before.children.some((task) => task.id === activeGrant.taskId)) {
        throw new Error(`Execution grant ${activeGrant.id} belongs to task ${activeGrant.taskId}, not feature ${before.feature.id}.`);
      }
      const pausedExecution = await this.pauseExecution?.(normalizedReason);
      if (pausedExecution === undefined) throw new Error(`Execution grant ${activeGrant.id} could not be paused for recovery.`);
    }
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, "recovery_required", "recovery", {
      kind: "dstack.feature.recovery_required",
      actor: "system",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: { featureId: before.feature.id, reason: normalizedReason },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "recovery", before, after, snapshot, event };
  }

  async resumeFeature(featureId: string, confirmed: boolean): Promise<DstackLifecycleTransition | undefined> {
    const before = await this.inspectFeature(featureId);
    if (before.status !== "paused" && before.status !== "recovery_required") {
      throw new Error(`Feature ${before.feature.id} is not paused or awaiting recovery.`);
    }
    if (before.feature.status !== "in_progress") {
      throw new Error(`Feature ${before.feature.id} provider state is ${before.feature.status}; reconcile it before recovery continuation.`);
    }
    if (!confirmed) return undefined;
    const hadActiveExecution = this.ledger.getActiveExecutionGrant() !== undefined;
    const resumed = await this.resumeExecution?.();
    if (hadActiveExecution && resumed === undefined) {
      throw new Error(`Feature ${before.feature.id} execution could not resume; inspect the recovery boundary.`);
    }
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, hadActiveExecution ? "implementing" : "active", hadActiveExecution ? "implement" : "start", {
      kind: "dstack.feature.recovered",
      actor: "user",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: { featureId: before.feature.id, resumedExecution: hadActiveExecution },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "recovery", before, after, snapshot, event };
  }

  async beginReview(featureId: string, confirmed: boolean): Promise<DstackLifecycleTransition | undefined> {
    const before = await this.inspectFeature(featureId);
    if (before.status !== "implementing" && before.status !== "active") {
      throw new Error(`Feature ${before.feature.id} is not implementing; review cannot begin from ${before.status}.`);
    }
    const incomplete = before.children.filter((task) => !terminal(task));
    if (incomplete.length > 0) {
      throw new Error(`Feature ${before.feature.id} still has open implementation tasks: ${incomplete.map((task) => task.id).join(", ")}.`);
    }
    const activeGrant = this.ledger.getActiveExecutionGrant();
    if (activeGrant !== undefined) {
      throw new Error(`Execution grant ${activeGrant.id} remains active during feature review.`);
    }
    if (!confirmed) return undefined;
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, "reviewing", "review", {
      kind: "dstack.feature.review_started",
      actor: "user",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: { featureId: before.feature.id, childCount: before.children.length },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "review", before, after, snapshot, event };
  }

  async auditFeature(featureId: string): Promise<DstackAudit> {
    const inspection = await this.inspectFeature(featureId);
    const closeBlockers = [
      ...(inspection.blockers.length === 0 ? [] : [this.blockerReason(inspection)]),
      ...(inspection.missingDependencies.length === 0 ? [] : [`Missing dependencies: ${inspection.missingDependencies.join(", ")}.`]),
      ...(inspection.children.some((task) => !terminal(task)) ? ["Implementation tasks are not all closed or deferred."] : []),
      ...(inspection.status !== "reviewing" ? [`Feature is not in review state; current state is ${inspection.status}.`] : []),
    ];
    const activeGrant = this.ledger.getActiveExecutionGrant();
    if (activeGrant !== undefined && inspection.children.some((task) => task.id === activeGrant.taskId)) {
      closeBlockers.push(`Execution grant ${activeGrant.id} remains active for task ${activeGrant.taskId}.`);
    }
    return { inspection, closeReady: closeBlockers.length === 0, closeBlockers };
  }

  async closeFeature(featureId: string, options: DstackFeatureCloseOptions): Promise<DstackLifecycleTransition | undefined> {
    const before = await this.inspectFeature(featureId);
    if (before.feature.status !== "in_progress") {
      throw new Error(`Feature ${before.feature.id} is not open for closure; provider status is ${before.feature.status}.`);
    }
    const audit = await this.auditFeature(featureId);
    if (!options.reviewComplete) audit.closeBlockers.push("Current feature review evidence is incomplete.");
    if (!options.gatesComplete) audit.closeBlockers.push("Current repository quality-gate evidence is incomplete.");
    if (audit.closeBlockers.length > 0) throw new Error(`Feature ${before.feature.id} cannot close: ${audit.closeBlockers.join(" ")}`);
    if (!options.confirmed) return undefined;
    const reason = options.reason.trim();
    if (!reason) throw new Error("Closing a dstack feature requires an explicit reason.");
    const closed = await this.provider.close(before.feature.id, reason);
    const snapshot = this.repository.snapshot();
    const event = this.persistLifecycle(before.feature.id, "completed", "close", {
      kind: "dstack.feature.closed",
      actor: "user",
      taskId: before.feature.id,
      repositorySnapshot: snapshot,
      payload: {
        featureId: before.feature.id,
        reason,
        reviewComplete: options.reviewComplete,
        gatesComplete: options.gatesComplete,
        childIds: before.children.map((task) => task.id),
      },
    });
    const after = await this.inspectFeature(before.feature.id);
    return { action: "close", before, after: { ...after, feature: closed }, snapshot, event };
  }

  private requireStartable(feature: DstackFeatureInspection): void {
    if (feature.feature.status !== "open" && feature.feature.status !== "in_progress") {
      throw new Error(`Feature ${feature.feature.id} has provider status ${feature.feature.status}; only open or in-progress roots can start.`);
    }
    if (feature.blockers.length > 0 || feature.missingDependencies.length > 0) {
      throw new Error(this.blockerReason(feature));
    }
  }

  private blockerReason(feature: DstackFeatureInspection): string {
    const blockers = feature.blockers.map((task) => `${task.id} (${task.status})`);
    const missing = feature.missingDependencies.length === 0 ? "" : ` missing dependencies: ${feature.missingDependencies.join(", ")}.`;
    return `Feature ${feature.feature.id} is blocked by ${blockers.join(", ") || "unresolved dependencies"}.${missing}`;
  }

  private persistLifecycle(
    featureId: string,
    status: DstackLifecycleStatus,
    phase: DstackLifecyclePhase,
    event: Parameters<SqliteLedger["saveStateTransition"]>[0]["event"],
  ): LedgerEvent {
    return this.ledger.saveStateTransition({
      stateUpdates: {
        [FEATURE_STATE_KEY]: featureId,
        [STATUS_STATE_KEY]: status,
        [PHASE_STATE_KEY]: phase,
        [REASON_STATE_KEY]: event.kind,
      },
      event,
    });
  }
}
