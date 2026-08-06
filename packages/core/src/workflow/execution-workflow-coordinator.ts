import type {
  ExecutionGrant,
  ExecutionPreparation,
  ExecutionTransition,
  PlanApproval,
  PlanTask,
  ReconciliationTransaction,
  TaskProviderIdentity,
  TaskReconciliation,
  TaskRecord,
  TaskStartTransition,
} from "../domain/types.ts";
import {
  repositoryBindingMismatch,
  sameRepositoryBindings,
  type RepositoryRevisionBinding,
  type RetrievalRevisionBinding,
} from "../repository/revision-binding.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { parsePlanFile } from "../planning/plan-parser.ts";
import { PlanReconciler } from "../planning/plan-reconciler.ts";
import type { RepositoryProvider } from "../repository/repository-provider.ts";
import type { RepositorySnapshot } from "../repository/snapshot.ts";
import { canonicalRepositoryRoot, repositoryPathTarget } from "../repository/repository-path.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";
import { sha256 } from "../util/hash.ts";
import { newId, nowIso } from "../util/ids.ts";
import {
  constraintsForPlanTask,
  createTaskConstraints,
  retrievalBindingDigest,
  taskConstraintDigest,
  createExecutionBaseline,
  executionBaselineDigest,
  executionConstraintsMatch,
  sameRetrievalBindings,
  sourceBaselineMismatch,
} from "./execution-baseline.ts";
import type { ValidationConstraintDescriptor } from "../planning/task-execution-scope.ts";

export interface ExecutionWorkflowCoordinatorOptions {
  planPath: string;
  ledger: SqliteLedger;
  provider: TaskProvider;
  repository: RepositoryProvider;
  repositoryRoot: string;
  repositoryBindings?: () => RepositoryRevisionBinding[] | Promise<RepositoryRevisionBinding[]>;
  retrievalBindings?: () => RetrievalRevisionBinding[] | Promise<RetrievalRevisionBinding[]>;
  validationConstraints?: () => ValidationConstraintDescriptor[];
  validationRequired?: () => boolean;
  repositoryRoots?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  primaryRepositoryId?: () => string | Promise<string>;
  sourceContext?: () => ExecutionSourceContext | Promise<ExecutionSourceContext>;
}

export interface ExecutionSourceContext {
  repositorySnapshot: RepositorySnapshot;
  repositoryBindings: RepositoryRevisionBinding[];
  retrievalBindings: RetrievalRevisionBinding[];
  repositoryRoots: Readonly<Record<string, string>>;
  primaryRepositoryId: string;
}

export interface ExecutionTransitionOptions {
  onPhase?: (phase: "revalidate" | "reconcile" | "converge" | "activate") => void | Promise<void>;
}

export interface StandaloneTaskExecutionOptions {
  taskId: string;
  /** Optional narrowing; omitted means all application-source paths in the repository. */
  writePaths?: string[];
  validations?: string[];
  allowDependencyChanges?: boolean;
  allowFullSuite?: boolean;
  allowLocalChange?: boolean;
}

const STANDALONE_TASK_TYPES = new Set(["bug", "feature", "task", "chore", "spike"]);

function providerIdentity(name: string, version: string | undefined): TaskProviderIdentity {
  return { name, ...(version === undefined ? {} : { version }) };
}

function sameProvider(left: TaskProviderIdentity, right: TaskProviderIdentity): boolean {
  return left.name === right.name && left.version === right.version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExecutionWorkflowCoordinator {
  private readonly planPath: string;
  private readonly ledger: SqliteLedger;
  private readonly provider: TaskProvider;
  private readonly repository: RepositoryProvider;
  private readonly repositoryRoot: string;
  private readonly repositoryBindings: () => RepositoryRevisionBinding[] | Promise<RepositoryRevisionBinding[]>;
  private readonly retrievalBindings: () => RetrievalRevisionBinding[] | Promise<RetrievalRevisionBinding[]>;
  private readonly validationConstraints: () => ValidationConstraintDescriptor[];
  private readonly validationRequired: () => boolean;
  private readonly repositoryRoots: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  private readonly primaryRepositoryId: () => string | Promise<string>;
  private readonly configuredSourceContext: (() => ExecutionSourceContext | Promise<ExecutionSourceContext>) | undefined;

  constructor(options: ExecutionWorkflowCoordinatorOptions) {
    this.repositoryRoot = canonicalRepositoryRoot(options.repositoryRoot);
    this.planPath = repositoryPathTarget(this.repositoryRoot, options.planPath, "write").entry;
    this.ledger = options.ledger;
    this.provider = options.provider;
    this.repository = options.repository;
    this.repositoryBindings = options.repositoryBindings ?? (() => []);
    this.retrievalBindings = options.retrievalBindings ?? (() => []);
    this.validationConstraints = options.validationConstraints ?? (() => []);
    this.validationRequired = options.validationRequired ?? (() => false);
    this.repositoryRoots = options.repositoryRoots ?? (() => ({ [this.repository.snapshot().repositoryId]: this.repositoryRoot }));
    this.primaryRepositoryId = options.primaryRepositoryId ?? (() => this.repository.snapshot().repositoryId);
    this.configuredSourceContext = options.sourceContext;
  }

  private async sourceContext(): Promise<ExecutionSourceContext> {
    if (this.configuredSourceContext !== undefined) return await this.configuredSourceContext();
    const repositorySnapshot = this.repository.observe === undefined
      ? this.repository.snapshot()
      : (await this.repository.observe({ force: true })).snapshot;
    return {
      repositorySnapshot,
      repositoryBindings: await this.repositoryBindings(),
      retrievalBindings: await this.retrievalBindings(),
      repositoryRoots: await this.repositoryRoots(),
      primaryRepositoryId: await this.primaryRepositoryId(),
    };
  }

  async initializeProvider(confirmed: boolean): Promise<boolean> {
    const before = await this.provider.status();
    if (!before.available) throw new Error(before.reason ?? `Task provider ${before.provider} is unavailable.`);
    if (before.initialized) return true;
    if (!confirmed) return false;
    await this.provider.initialize({ quiet: true });
    const after = await this.provider.status();
    if (!after.available || !after.initialized) {
      throw new Error(after.reason ?? `Task provider ${after.provider} did not initialize.`);
    }
    this.ledger.append({
      kind: "task_provider.initialized",
      actor: "user",
      payload: { provider: providerIdentity(this.provider.name, after.version) },
    });
    return true;
  }

  async prepare(): Promise<ExecutionPreparation> {
    if (this.ledger.getActiveExecutionGrant() !== undefined) {
      throw new Error("Cancel the active execution grant before preparing another execution transaction.");
    }
    const plan = parsePlanFile(this.planPath);
    const errors = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length > 0) throw new Error(`Plan cannot be prepared: ${errors.map((item) => item.message).join("; ")}`);
    if (this.ledger.getState<string>("reviewedPlanHash") !== plan.hash) {
      throw new Error("Plan cannot be prepared until the exact current revision has completed ManualEdit review.");
    }
    const status = await this.provider.status();
    if (!status.available || !status.initialized) {
      throw new Error(status.reason ?? `Task provider ${status.provider} is unavailable or uninitialized.`);
    }

    const reconciliation = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    const source = await this.sourceContext();
    const snapshot = source.repositorySnapshot;
    const repositoryBindings = source.repositoryBindings;
    const retrievalBindings = source.retrievalBindings;
    const taskConstraints = createTaskConstraints(
      plan.tasks,
      this.repositoryRoot,
      this.validationConstraints(),
      { requireValidation: this.validationRequired(), repositoryRoots: source.repositoryRoots, primaryRepositoryId: source.primaryRepositoryId },
    );
    const timestamp = nowIso();
    const approval: PlanApproval = {
      id: newId("approval"),
      status: "prepared",
      planPath: this.planPath,
      planHash: plan.hash,
      reconciliationDigest: reconciliation.digest,
      provider: reconciliation.provider,
      workspaceId: snapshot.workspaceId,
      repositoryId: snapshot.repositoryId,
      repositorySnapshot: snapshot,
      repositoryBindings,
      retrievalBindings,
      taskConstraints,
      constraintDigest: taskConstraintDigest(taskConstraints),
      preparedAt: timestamp,
    };
    const transaction: ReconciliationTransaction = {
      id: newId("reconciliation"),
      planApprovalId: approval.id,
      status: "prepared",
      planHash: plan.hash,
      reconciliationDigest: reconciliation.digest,
      provider: reconciliation.provider,
      preview: reconciliation,
      preparedAt: timestamp,
      updatedAt: timestamp,
    };
    this.ledger.savePlanApproval(approval);
    this.ledger.saveReconciliationTransaction(transaction);
    this.ledger.append({
      kind: "execution.prepared",
      actor: "user",
      repositorySnapshot: snapshot,
      payload: {
        planApprovalId: approval.id,
        reconciliationTransactionId: transaction.id,
        planHash: plan.hash,
        reconciliationDigest: reconciliation.digest,
        operationCount: reconciliation.operations.length,
        conflicts: reconciliation.conflicts,
        repositorySnapshot: snapshot,
        repositoryBindingCount: repositoryBindings.length,
        retrievalBindingCount: retrievalBindings.length,
        taskConstraints,
        constraintDigest: approval.constraintDigest,
      },
    });
    return { approval, transaction, reconciliation };
  }

  async approveAndApply(
    planApprovalId: string,
    confirmed: boolean,
    options: ExecutionTransitionOptions = {},
  ): Promise<ExecutionTransition> {
    const approval = this.requiredApproval(planApprovalId);
    const transaction = this.requiredTransaction(planApprovalId);
    if (approval.status !== "prepared" || transaction.status !== "prepared") {
      throw new Error(`Execution preparation ${planApprovalId} is no longer pending approval.`);
    }
    if (!confirmed) {
      const timestamp = nowIso();
      const rejected: PlanApproval = { ...approval, status: "rejected", decidedAt: timestamp };
      const cancelled: ReconciliationTransaction = { ...transaction, status: "cancelled", updatedAt: timestamp };
      this.ledger.savePlanApproval(rejected);
      this.ledger.saveReconciliationTransaction(cancelled);
      this.ledger.append({
        kind: "execution.rejected",
        actor: "user",
        payload: { planApprovalId, reconciliationTransactionId: transaction.id },
      });
      return { approval: rejected, transaction: cancelled, reconciliation: transaction.preview };
    }

    await options.onPhase?.("revalidate");
    const plan = parsePlanFile(this.planPath);
    const reconciler = new PlanReconciler(this.provider, this.ledger);
    const current = await reconciler.preview(plan);
    const source = await this.sourceContext();
    const currentConstraints = createTaskConstraints(
      plan.tasks,
      this.repositoryRoot,
      this.validationConstraints(),
      { requireValidation: this.validationRequired(), repositoryRoots: source.repositoryRoots, primaryRepositoryId: source.primaryRepositoryId },
    );
    const snapshot = source.repositorySnapshot;
    const mismatch = this.preparationMismatch(
      approval,
      plan.hash,
      current.provider,
      current.digest,
      snapshot,
      source.repositoryBindings,
      source.retrievalBindings,
      currentConstraints,
    );
    if (mismatch !== undefined) {
      this.invalidatePreparation(approval, transaction, mismatch);
      throw new Error(`Execution state changed after preparation: ${mismatch}`);
    }
    if (current.conflicts.length > 0) {
      const reason = `reconciliation has conflicts: ${current.conflicts.join("; ")}`;
      this.invalidatePreparation(approval, transaction, reason);
      throw new Error(reason);
    }
    const active = this.ledger.getActiveExecutionGrant();
    if (active !== undefined) {
      const reason = `Execution grant ${active.id} became active after preparation.`;
      this.invalidatePreparation(approval, transaction, reason);
      throw new Error(reason);
    }

    const timestamp = nowIso();
    const accepted: PlanApproval = { ...approval, status: "accepted", decidedAt: timestamp };
    let applying: ReconciliationTransaction = { ...transaction, status: "applying", preview: current, updatedAt: timestamp };
    try {
      this.ledger.beginExecutionApplication(accepted, applying);
    } catch (error) {
      const reason = `Execution application could not start exclusively: ${errorMessage(error)}`;
      this.invalidatePreparation(approval, transaction, reason);
      throw new Error(reason);
    }

    let applied;
    try {
      await options.onPhase?.("reconcile");
      applied = await reconciler.apply(plan, current, { revalidate: false });
      if (!applied.applied || applied.conflicts.length > 0) {
        throw new Error(`Reconciliation did not apply: ${applied.conflicts.join("; ")}`);
      }
      await options.onPhase?.("converge");
      const converged = await reconciler.preview(plan);
      if (converged.conflicts.length > 0 || converged.operations.length > 0) {
        throw new Error("Reconciliation did not converge after apply.");
      }
      const postApplySource = await this.sourceContext();
      const sourceDrift = sourceBaselineMismatch(approval.repositorySnapshot, postApplySource.repositorySnapshot);
      if (sourceDrift !== undefined) {
        throw new Error(`Source state changed while applying task reconciliation: ${sourceDrift}.`);
      }
      const workspaceDrift = repositoryBindingMismatch(approval.repositoryBindings, postApplySource.repositoryBindings);
      if (workspaceDrift !== undefined) {
        throw new Error(`Workspace source state changed while applying task reconciliation: ${workspaceDrift}.`);
      }
      if (!sameRetrievalBindings(approval.retrievalBindings, postApplySource.retrievalBindings)) {
        throw new Error("Retrieval revision bindings changed while applying task reconciliation.");
      }
      await options.onPhase?.("activate");
      const task = await this.claimReadyTask(plan.hash, plan.tasks.map((item) => item.id));
      const approved: PlanApproval = { ...accepted, status: "approved" };
      const grant = this.executionGrant(
        approved,
        transaction.id,
        task,
        postApplySource.repositorySnapshot,
        postApplySource.repositoryBindings,
        postApplySource.retrievalBindings,
      );
      applying = { ...applying, status: "applied", preview: applied, updatedAt: nowIso() };
      this.ledger.activateExecution({
        approval: approved,
        transaction: applying,
        grant,
      });
      this.ledger.setWorkflowCheckpoint("executing");
      return { approval: approved, transaction: applying, reconciliation: applied, task, executionGrant: grant };
    } catch (error) {
      this.ledger.failExecutionApplication(accepted, applying, errorMessage(error));
      throw error;
    }
  }

  async startStandaloneTask(options: StandaloneTaskExecutionOptions, confirmed: boolean): Promise<TaskStartTransition | undefined> {
    if (this.ledger.getActiveExecutionGrant() !== undefined) {
      throw new Error("Cancel the active execution grant before starting a standalone task.");
    }
    const taskId = options.taskId.trim();
    if (!taskId) throw new Error("A standalone task id is required.");
    const requestedWritePaths = (options.writePaths ?? []).map((path) => path.trim()).filter(Boolean);
    const writePaths = requestedWritePaths.length === 0 ? ["."] : requestedWritePaths;

    const status = await this.provider.status();
    if (!status.available || !status.initialized) {
      throw new Error(status.reason ?? `Task provider ${status.provider} is unavailable or uninitialized.`);
    }
    const task = await this.provider.get(taskId);
    if (task === undefined) throw new Error(`Standalone task ${taskId} was not found.`);
    if (!STANDALONE_TASK_TYPES.has(task.type)) {
      throw new Error(`Task ${task.id} has non-executable type ${task.type}; standalone activation accepts task, bug, feature, chore, or spike issues.`);
    }
    if (task.parentId !== undefined || task.labels.includes("workflow:feature")) {
      throw new Error(`Task ${task.id} belongs to a parent workflow; use the owning feature execution flow instead of standalone activation.`);
    }
    if (task.status !== "open" && task.status !== "in_progress") {
      throw new Error(`Task ${task.id} has status ${task.status}; only open or in-progress tasks can be activated.`);
    }
    if (task.status === "open") {
      const ready = await this.provider.ready();
      if (!ready.some((candidate) => candidate.id === task.id)) {
        throw new Error(`Task ${task.id} is not provider-ready; resolve its blockers before standalone activation.`);
      }
    } else {
      const previous = this.ledger.listExecutionGrants().find((grant) => grant.taskId === task.id);
      if (previous?.status !== "revoked" || previous.executionSource !== "standalone") {
        throw new Error(`Task ${task.id} is already in progress without a resumable standalone execution owned by Atelier.`);
      }
    }

    const source = await this.sourceContext();
    const validationNames = [...new Set((options.validations ?? []).map((name) => name.trim()).filter(Boolean))].sort();
    const planTask: PlanTask = {
      id: task.id,
      title: task.title,
      goal: task.description || task.title,
      description: task.description,
      scope: [...writePaths],
      outOfScope: [],
      dependencies: [...task.dependencies],
      validation: validationNames,
      completionCriteria: [...task.acceptanceCriteria],
      notes: task.notes === undefined ? [] : [task.notes],
      priority: task.priority,
      type: task.type,
      execution: {
        writePaths: [...writePaths],
        allowDependencyChanges: options.allowDependencyChanges === true,
        validations: validationNames,
        allowFullSuite: options.allowFullSuite === true,
        allowLocalChange: options.allowLocalChange !== false,
      },
      source: { startLine: 0, endLine: 0 },
    };
    const taskConstraints = createTaskConstraints(
      [planTask],
      this.repositoryRoot,
      this.validationConstraints(),
      {
        requireValidation: this.validationRequired(),
        repositoryRoots: source.repositoryRoots,
        primaryRepositoryId: source.primaryRepositoryId,
      },
    );
    const provider = providerIdentity(this.provider.name, status.version);
    const constraintDigest = taskConstraintDigest(taskConstraints);
    const planHash = sha256(JSON.stringify({
      executionSource: "standalone",
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        priority: task.priority,
        type: task.type,
        dependencies: task.dependencies,
      },
      provider,
      taskConstraints,
    }));
    const reconciliationDigest = sha256(JSON.stringify({ executionSource: "standalone", taskId: task.id, provider, constraintDigest }));
    const timestamp = nowIso();
    const approval: PlanApproval = {
      id: newId("approval"),
      executionSource: "standalone",
      status: "approved",
      planPath: this.planPath,
      planHash,
      reconciliationDigest,
      provider,
      workspaceId: source.repositorySnapshot.workspaceId,
      repositoryId: source.repositorySnapshot.repositoryId,
      repositorySnapshot: source.repositorySnapshot,
      repositoryBindings: source.repositoryBindings,
      retrievalBindings: source.retrievalBindings,
      taskConstraints,
      constraintDigest,
      preparedAt: timestamp,
      decidedAt: timestamp,
    };
    const reconciliation: TaskReconciliation = {
      planHash,
      provider,
      digest: reconciliationDigest,
      operations: [],
      unchanged: [task.id],
      created: [],
      applied: true,
      conflicts: [],
    };
    const transaction: ReconciliationTransaction = {
      id: newId("reconciliation"),
      planApprovalId: approval.id,
      status: "applied",
      planHash,
      reconciliationDigest,
      provider,
      preview: reconciliation,
      preparedAt: timestamp,
      updatedAt: timestamp,
    };
    if (!confirmed) return undefined;
    const claimed = task.status === "in_progress" ? task : await this.provider.claim(task.id);
    if (claimed.status !== "in_progress") throw new Error(`Task ${claimed.id} claim returned status ${claimed.status}.`);
    const activeTask = { ...claimed, planTaskId: task.id };
    this.ledger.setTaskMapping(task.id, this.provider.name, claimed.id, planHash);
    const grant = this.executionGrant(
      approval,
      transaction.id,
      activeTask,
      source.repositorySnapshot,
      source.repositoryBindings,
      source.retrievalBindings,
    );
    this.ledger.activateExecution({ approval, transaction, grant });
    this.ledger.setWorkflowCheckpoint("executing");
    this.ledger.append({
      kind: "execution.standalone_started",
      actor: "user",
      taskId: claimed.id,
      repositorySnapshot: source.repositorySnapshot,
      payload: {
        executionGrantId: grant.id,
        taskId: claimed.id,
        writePaths: taskConstraints[0]?.writePaths ?? [],
        validations: validationNames,
      },
    });
    return { task: activeTask, transaction, executionGrant: grant };
  }

  async startNextTask(confirmed: boolean, requestedTaskId?: string): Promise<TaskStartTransition | undefined> {
    const active = this.ledger.getActiveExecutionGrant();
    const previous = active ?? this.ledger.listExecutionGrants().find((grant) => grant.status === "revoked");
    if (previous === undefined) throw new Error("No prior approved execution grant exists for task continuation.");
    if (previous.executionSource === "standalone") {
      throw new Error(`Standalone task ${previous.taskId} must be activated explicitly with its task scope; later plan-task activation is unavailable.`);
    }
    const currentTask = await this.provider.get(previous.taskId);
    if (currentTask !== undefined && currentTask.status !== "closed" && currentTask.status !== "deferred") {
      throw new Error(`Current task ${currentTask.id} has status ${currentTask.status}; later task activation is not available.`);
    }
    const invalid = await this.invalidReason(previous);
    if (invalid !== undefined && !invalid.includes("status")) {
      if (active !== undefined) this.ledger.invalidateExecutionGrant(previous.id, { status: "invalidated", reason: invalid });
      throw new Error(invalid);
    }
    if (!confirmed) return undefined;

    const approval = this.requiredApproval(previous.planApprovalId);
    const plan = parsePlanFile(this.planPath);
    const preview = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    if (plan.hash !== approval.planHash || !sameProvider(preview.provider, approval.provider)
      || taskConstraintDigest(approval.taskConstraints) !== approval.constraintDigest
      || preview.conflicts.length > 0 || preview.operations.length > 0) {
      const reason = "Plan or provider reconciliation changed before later task activation.";
      this.ledger.invalidateExecutionGrant(previous.id, { status: "invalidated", reason });
      throw new Error(reason);
    }

    if (active !== undefined) {
      const revoked = this.ledger.invalidateExecutionGrant(previous.id, {
        status: "revoked",
        reason: `Previous task ${previous.taskId} completed before later task activation.`,
      });
      if (revoked === undefined) throw new Error("Previous execution grant disappeared before later task activation.");
    }
    const timestamp = nowIso();
    const applying: ReconciliationTransaction = {
      id: newId("reconciliation"),
      planApprovalId: approval.id,
      status: "applying",
      planHash: approval.planHash,
      reconciliationDigest: approval.reconciliationDigest,
      provider: approval.provider,
      preview,
      preparedAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.ledger.beginExecutionApplication(approval, applying);
    } catch (error) {
      this.ledger.saveReconciliationTransaction({
        ...applying,
        status: "failed",
        updatedAt: nowIso(),
        error: errorMessage(error),
      });
      throw new Error(`Later task activation could not start exclusively: ${errorMessage(error)}`);
    }
    try {
      const task = await this.claimReadyTask(plan.hash, plan.tasks.map((item) => item.id), requestedTaskId);
      const transaction: ReconciliationTransaction = { ...applying, status: "applied", updatedAt: nowIso() };
      const source = await this.sourceContext();
      const grant = this.executionGrant(
        approval,
        transaction.id,
        task,
        source.repositorySnapshot,
        source.repositoryBindings,
        source.retrievalBindings,
      );
      this.ledger.activateExecution({
        approval,
        transaction,
        grant,
      });
      this.ledger.setWorkflowCheckpoint("executing");
      return { task, transaction, executionGrant: grant };
    } catch (error) {
      this.ledger.failExecutionApplication(approval, applying, errorMessage(error));
      throw error;
    }
  }


  async resumeCancelledTask(confirmed: boolean, requestedTaskId?: string): Promise<TaskStartTransition | undefined> {
    const previous = this.ledger.listExecutionGrants().find((grant) => grant.status === "revoked" && (requestedTaskId === undefined || grant.taskId === requestedTaskId));
    if (previous === undefined) throw new Error("No cancelled approved execution is available to resume.");
    const task = await this.provider.get(previous.taskId);
    if (task === undefined) throw new Error(`Cancelled task ${previous.taskId} is unavailable.`);
    if (task.status !== "in_progress" && task.status !== "open") throw new Error(`Task ${task.id} has status ${task.status}; cancelled execution cannot resume.`);
    const invalid = await this.invalidReason(previous);
    if (invalid !== undefined && !invalid.includes("status")) throw new Error(`Cancelled execution requires a fresh plan transaction: ${invalid}`);
    if (!confirmed) return undefined;
    const approval = this.requiredApproval(previous.planApprovalId);
    const plan = parsePlanFile(this.planPath);
    const preview = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    if (plan.hash !== approval.planHash || preview.conflicts.length > 0 || preview.operations.length > 0) {
      throw new Error("Plan or task-provider reconciliation changed after cancellation; prepare a fresh exact transaction.");
    }
    const timestamp = nowIso();
    const transaction: ReconciliationTransaction = {
      id: newId("reconciliation"), planApprovalId: approval.id, status: "applied", planHash: approval.planHash,
      reconciliationDigest: approval.reconciliationDigest, provider: approval.provider, preview, preparedAt: timestamp, updatedAt: timestamp,
    };
    const source = await this.sourceContext();
    const grant = this.executionGrant(
      approval,
      transaction.id,
      task,
      source.repositorySnapshot,
      source.repositoryBindings,
      source.retrievalBindings,
    );
    this.ledger.activateExecution({ approval, transaction, grant });
    this.ledger.setWorkflowCheckpoint("executing");
    this.ledger.append({ kind: "execution.cancelled_task_resumed", actor: "user", taskId: task.id, repositorySnapshot: source.repositorySnapshot, payload: { previousExecutionGrantId: previous.id, executionGrantId: grant.id } });
    return { task, transaction, executionGrant: grant };
  }

  cancel(reason: string, outcome: "cancelled" | "completed" = "cancelled"): ExecutionGrant | undefined {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return undefined;
    return this.ledger.invalidateExecutionGrant(grant.id, {
      status: "revoked",
      reason,
      workflowStatus: outcome,
      workflowCheckpoint: outcome,
    });
  }

  pause(reason: string, options: { checkpointId?: string } = {}): ExecutionGrant | undefined {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return undefined;
    this.ledger.pauseExecution(grant, reason, options);
    return grant;
  }

  async resumePaused(): Promise<ExecutionGrant | undefined> {
    const grant = this.ledger.getActiveExecutionGrant();
    const pause = this.ledger.getExecutionPause();
    if (grant === undefined || pause?.executionGrantId !== grant.id) return undefined;
    const reason = this.pausedBaselineMismatch(grant);
    if (reason !== undefined) {
      this.ledger.invalidateExecutionGrant(grant.id, { status: "invalidated", reason });
      return undefined;
    }
    if (this.provider.name !== "memory") {
      const providerReason = await this.invalidReason(grant);
      if (providerReason !== undefined) {
        this.ledger.invalidateExecutionGrant(grant.id, { status: "invalidated", reason: providerReason });
        return undefined;
      }
    }
    if (!this.ledger.resumePausedExecution(grant)) return undefined;
    return grant;
  }

  isPaused(): boolean {
    const grant = this.ledger.getActiveExecutionGrant();
    return grant !== undefined && this.ledger.getExecutionPause()?.executionGrantId === grant.id;
  }

  private pausedBaselineMismatch(grant: ExecutionGrant): string | undefined {
    if (grant.executionBaseline !== undefined
      && (grant.executionBaseline.digest !== executionBaselineDigest(grant.executionBaseline)
        || grant.executionBaseline.executionGrantId !== grant.id)) {
      return "Paused execution baseline is invalid or incomplete.";
    }
    const current = this.repository.snapshot();
    if (grant.repositorySnapshot.repositoryId !== current.repositoryId) return "Paused execution baseline changed: repository identity changed.";
    if (grant.repositorySnapshot.workspaceId !== current.workspaceId) return "Paused execution baseline changed: workspace identity changed.";
    if (grant.repositorySnapshot.vcs !== current.vcs) return "Paused execution baseline changed: repository provider changed.";
    if ((grant.repositorySnapshot.sourceBaseCommit ?? grant.repositorySnapshot.headCommit)
      !== (current.sourceBaseCommit ?? current.headCommit)) {
      return "Paused execution baseline changed: source base changed.";
    }
    if (grant.repositorySnapshot.indexSchemaVersion !== current.indexSchemaVersion) {
      return "Paused execution baseline changed: repository index schema changed.";
    }
    return undefined;
  }

  async resume(): Promise<ExecutionGrant | undefined> {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) {
      const interrupted = this.ledger.listReconciliationTransactions().find((item) => item.status === "applying");
      if (interrupted !== undefined) {
        const approval = this.ledger.getPlanApproval(interrupted.planApprovalId);
        const reason = "Execution was interrupted while applying provider reconciliation; prepare and confirm a fresh exact transaction.";
        if (approval !== undefined) this.ledger.failExecutionApplication(approval, interrupted, reason);
        else {
          this.ledger.saveReconciliationTransaction({
            ...interrupted,
            status: "failed",
            updatedAt: nowIso(),
            error: reason,
          });
          this.ledger.setState("workflowMode", "plan");
        }
      } else if (this.ledger.getState<string>("workflowMode") === "act") {
        this.ledger.setState("workflowMode", "plan");
      }
      return undefined;
    }
    const reason = await this.invalidReason(grant);
    if (reason !== undefined) {
      this.ledger.invalidateExecutionGrant(grant.id, { status: "invalidated", reason });
      return undefined;
    }
    this.ledger.restoreExecution(grant);
    return grant;
  }

  private requiredApproval(id: string): PlanApproval {
    const approval = this.ledger.getPlanApproval(id);
    if (approval === undefined) throw new Error(`Unknown plan approval: ${id}`);
    return approval;
  }

  private requiredTransaction(planApprovalId: string): ReconciliationTransaction {
    const transaction = this.ledger.getApprovalReconciliationTransaction(planApprovalId);
    if (transaction === undefined) throw new Error(`No reconciliation transaction exists for approval ${planApprovalId}.`);
    return transaction;
  }

  private preparationMismatch(
    approval: PlanApproval,
    planHash: string,
    provider: TaskProviderIdentity,
    reconciliationDigest: string,
    snapshot: ReturnType<RepositoryProvider["snapshot"]>,
    repositoryBindings: RepositoryRevisionBinding[],
    retrievalBindings: RetrievalRevisionBinding[],
    taskConstraints: PlanApproval["taskConstraints"],
  ): string | undefined {
    if (approval.planHash !== planHash) return "plan hash changed";
    if (!sameProvider(approval.provider, provider)) return "provider identity changed";
    if (approval.reconciliationDigest !== reconciliationDigest) return "reconciliation digest changed";
    const sourceMismatch = sourceBaselineMismatch(approval.repositorySnapshot, snapshot);
    if (sourceMismatch !== undefined) return sourceMismatch;
    const workspaceMismatch = repositoryBindingMismatch(approval.repositoryBindings, repositoryBindings);
    if (workspaceMismatch !== undefined) return workspaceMismatch;
    if (!sameRetrievalBindings(approval.retrievalBindings, retrievalBindings)) return "retrieval revision bindings changed";
    if (taskConstraintDigest(approval.taskConstraints) !== approval.constraintDigest
      || taskConstraintDigest(taskConstraints) !== approval.constraintDigest) return "execution task constraint projection changed";
    return undefined;
  }

  private invalidatePreparation(
    approval: PlanApproval,
    transaction: ReconciliationTransaction,
    reason: string,
  ): void {
    const timestamp = nowIso();
    this.ledger.savePlanApproval({
      ...approval,
      status: "invalidated",
      decidedAt: timestamp,
      invalidationReason: reason,
    });
    this.ledger.saveReconciliationTransaction({
      ...transaction,
      status: "failed",
      updatedAt: timestamp,
      error: reason,
    });
    this.ledger.append({
      kind: "execution.preparation_invalidated",
      actor: "system",
      payload: { planApprovalId: approval.id, reconciliationTransactionId: transaction.id, reason },
    });
  }

  private async claimReadyTask(planHash: string, planOrderIds: string[], requestedTaskId?: string): Promise<TaskRecord> {
    const order = new Map(planOrderIds.map((id, index) => [id, index]));
    const mappings = this.ledger.listTaskMappings().filter((mapping) =>
      mapping.provider === this.provider.name && mapping.planHash === planHash && order.has(mapping.planTaskId));
    const byProvider = new Map(mappings.map((mapping) => [mapping.providerTaskId, mapping.planTaskId]));
    const ready = (await this.provider.ready()).filter((task) => byProvider.has(task.id)).sort((left, right) =>
      left.priority - right.priority
      || (order.get(byProvider.get(left.id)!) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(byProvider.get(right.id)!) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id));
    let selected = requestedTaskId === undefined
      ? ready[0]
      : ready.find((task) => task.id === requestedTaskId);
    if (requestedTaskId !== undefined && selected === undefined) {
      throw new Error(`Requested approved-plan task ${requestedTaskId} is not ready for activation.`);
    }
    let alreadyClaimed = selected?.status === "in_progress";
    if (selected === undefined) {
      const recoverable = (await this.provider.list()).filter((task) =>
        task.status === "in_progress" && byProvider.has(task.id));
      if (recoverable.length > 1) {
        throw new Error(`Multiple approved-plan tasks are already in progress: ${recoverable.map((task) => task.id).join(", ")}.`);
      }
      selected = recoverable[0];
      alreadyClaimed = selected !== undefined;
    }
    if (selected === undefined) throw new Error("No approved-plan task is ready for activation.");
    const claimed = alreadyClaimed ? selected : await this.provider.claim(selected.id);
    if (claimed.status !== "in_progress") throw new Error(`Task ${claimed.id} claim returned status ${claimed.status}.`);
    const planTaskId = byProvider.get(claimed.id);
    if (planTaskId === undefined || (claimed.planTaskId !== undefined && claimed.planTaskId !== planTaskId)) {
      throw new Error(`Claimed task ${claimed.id} is not bound to the approved plan.`);
    }
    return { ...claimed, planTaskId };
  }

  private executionGrant(
    approval: PlanApproval,
    transactionId: string,
    task: TaskRecord,
    repositorySnapshot = approval.repositorySnapshot,
    repositoryBindings = approval.repositoryBindings,
    retrievalBindings = approval.retrievalBindings,
  ): ExecutionGrant {
    if (task.planTaskId === undefined) throw new Error(`Task ${task.id} has no approved plan identity.`);
    const selectedConstraints = constraintsForPlanTask(approval.taskConstraints, task.planTaskId);
    if (selectedConstraints.length !== 1) throw new Error(`Task ${task.id} has no unique approved execution constraint.`);
    const constraint = selectedConstraints[0]!;
    const executionId = newId("execution");
    const issuedAt = nowIso();
    const executionBaseline = createExecutionBaseline({
      version: 1,
      planHash: approval.planHash,
      reconciliationDigest: approval.reconciliationDigest,
      provider: approval.provider,
      workspaceId: repositorySnapshot.workspaceId,
      repositoryId: repositorySnapshot.repositoryId,
      repositorySnapshot,
      repositoryBindings: [...repositoryBindings],
      retrievalBindings: [...retrievalBindings],
      executionGrantId: executionId,
      taskId: task.id,
      planTaskId: task.planTaskId,
      ...(task.assignee === undefined ? {} : { taskOwner: task.assignee }),
      approvalConstraintDigest: approval.constraintDigest,
      constraintDigest: taskConstraintDigest(selectedConstraints),
      writePaths: [...constraint.writePaths],
      dependencyPaths: [...constraint.dependencyPaths],
      allowDependencyChanges: constraint.allowDependencyChanges,
      focusedValidations: [...constraint.focusedValidations],
      fullValidations: [...constraint.fullValidations],
      allowFullSuite: constraint.allowFullSuite,
      allowLocalChange: constraint.allowLocalChange,
      capturedAt: issuedAt,
    });
    return {
      id: executionId,
      ...(approval.executionSource === undefined ? {} : { executionSource: approval.executionSource }),
      status: "active",
      planApprovalId: approval.id,
      reconciliationTransactionId: transactionId,
      planHash: approval.planHash,
      reconciliationDigest: approval.reconciliationDigest,
      provider: approval.provider,
      workspaceId: repositorySnapshot.workspaceId,
      repositoryId: repositorySnapshot.repositoryId,
      repositorySnapshot,
      repositoryBindings,
      retrievalBindings,
      executionBaseline,
      approvalConstraintDigest: approval.constraintDigest,
      constraintDigest: taskConstraintDigest(selectedConstraints),
      taskId: task.id,
      planTaskId: task.planTaskId,
      issuedAt,
    };
  }

  private async invalidReason(grant: ExecutionGrant): Promise<string | undefined> {
    const approval = this.ledger.getPlanApproval(grant.planApprovalId);
    if (approval === undefined || approval.status !== "approved") return "Plan approval is unavailable or changed.";
    if (grant.executionBaseline !== undefined
      && (grant.executionBaseline.digest !== executionBaselineDigest(grant.executionBaseline)
        || grant.executionBaseline.executionGrantId !== grant.id)) {
      return "Execution baseline is invalid or incomplete during execution resume.";
    }
    if (grant.executionSource === "standalone" || approval.executionSource === "standalone") {
      return this.invalidStandaloneReason(grant, approval);
    }
    let plan;
    try {
      plan = parsePlanFile(this.planPath);
    } catch (error) {
      return `Reviewed plan is unavailable during execution resume: ${errorMessage(error)}`;
    }
    if (plan.hash !== grant.planHash || approval.planHash !== grant.planHash) return "Plan hash changed after execution approval.";
    const diagnostics = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (diagnostics.length > 0) {
      return `Reviewed plan no longer satisfies the execution contract: ${diagnostics.map((item) => item.message).join("; ")}`;
    }
    let currentConstraints;
    try {
      const source = await this.sourceContext();
      currentConstraints = createTaskConstraints(
        plan.tasks,
        this.repositoryRoot,
        this.validationConstraints(),
        { requireValidation: this.validationRequired(), repositoryRoots: source.repositoryRoots, primaryRepositoryId: source.primaryRepositoryId },
      );
      const selectedConstraints = constraintsForPlanTask(approval.taskConstraints, grant.planTaskId);
      if (grant.approvalConstraintDigest !== approval.constraintDigest
        || grant.constraintDigest !== taskConstraintDigest(selectedConstraints)
        || taskConstraintDigest(approval.taskConstraints) !== approval.constraintDigest
        || taskConstraintDigest(currentConstraints) !== approval.constraintDigest
        || !executionConstraintsMatch(grant, approval.taskConstraints)) {
        return "Execution task constraint projection changed or is incomplete during execution resume.";
      }
      return await this.invalidReasonAfterConstraints(grant, approval, plan, source);
    } catch (error) {
      return `Reviewed task execution contract is unavailable or invalid: ${errorMessage(error)}`;
    }
  }

  private async invalidStandaloneReason(
    grant: ExecutionGrant,
    approval: PlanApproval,
  ): Promise<string | undefined> {
    if (grant.executionSource !== "standalone" || approval.executionSource !== "standalone") {
      return "Standalone execution source binding is incomplete.";
    }
    if (grant.planHash !== approval.planHash || grant.reconciliationDigest !== approval.reconciliationDigest) {
      return "Standalone task execution identity changed.";
    }
    const selectedConstraints = constraintsForPlanTask(approval.taskConstraints, grant.planTaskId);
    if (selectedConstraints.length !== 1
      || grant.approvalConstraintDigest !== approval.constraintDigest
      || grant.constraintDigest !== taskConstraintDigest(selectedConstraints)
      || taskConstraintDigest(approval.taskConstraints) !== approval.constraintDigest
      || !executionConstraintsMatch(grant, approval.taskConstraints)) {
      return "Standalone task execution constraints changed or are incomplete.";
    }
    const status = await this.provider.status();
    if (!status.available || !status.initialized) return "Task provider is unavailable during standalone execution resume.";
    if (!sameProvider(grant.provider, providerIdentity(this.provider.name, status.version))) {
      return "Task provider identity changed during standalone execution resume.";
    }
    const source = await this.sourceContext();
    const snapshot = source.repositorySnapshot;
    if (snapshot.workspaceId !== grant.workspaceId) return "Workspace changed during standalone execution resume.";
    if (snapshot.repositoryId !== grant.repositoryId) return "Repository changed during standalone execution resume.";
    if (snapshot.vcs !== grant.repositorySnapshot.vcs) return "Repository provider changed during standalone execution resume.";
    if ((snapshot.sourceBaseCommit ?? snapshot.headCommit)
      !== (grant.repositorySnapshot.sourceBaseCommit ?? grant.repositorySnapshot.headCommit)) {
      return "Source base changed during standalone execution resume.";
    }
    const primaryRepositoryId = grant.repositorySnapshot.repositoryId;
    const stableExpected = grant.repositoryBindings.filter((binding) => binding.snapshotRepositoryId !== primaryRepositoryId);
    const stableActual = source.repositoryBindings.filter((binding) => binding.snapshotRepositoryId !== primaryRepositoryId);
    if (!sameRepositoryBindings(stableExpected, stableActual)) {
      return "A secondary workspace repository changed during standalone execution resume.";
    }
    const task = await this.provider.get(grant.taskId);
    if (task === undefined) return "Standalone execution task is unavailable during resume.";
    if (task.status !== "in_progress") return `Standalone execution task status changed to ${task.status}.`;
    if (grant.executionBaseline !== undefined
      && (grant.executionBaseline.taskOwner ?? "") !== (task.assignee ?? "")) {
      return "Standalone execution task ownership changed during resume.";
    }
    return undefined;
  }

  private async invalidReasonAfterConstraints(
    grant: ExecutionGrant,
    approval: PlanApproval,
    plan: ReturnType<typeof parsePlanFile>,
    source: ExecutionSourceContext,
  ): Promise<string | undefined> {
    const status = await this.provider.status();
    if (!status.available || !status.initialized) return "Task provider is unavailable during execution resume.";
    if (!sameProvider(grant.provider, providerIdentity(this.provider.name, status.version))) return "Task provider identity changed during execution resume.";
    const reconciliation = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    if (!sameProvider(reconciliation.provider, grant.provider)
      || reconciliation.conflicts.length > 0 || reconciliation.operations.length > 0) {
      return "Task provider reconciliation changed during execution resume.";
    }
    const snapshot = source.repositorySnapshot;
    if (snapshot.workspaceId !== grant.workspaceId) return "Workspace changed during execution resume.";
    if (snapshot.repositoryId !== grant.repositoryId) return "Repository changed during execution resume.";
    const exactSource = sourceBaselineMismatch(grant.repositorySnapshot, snapshot) === undefined;
    const currentRepositoryBindings = source.repositoryBindings;
    const primaryRepositoryId = grant.repositorySnapshot.repositoryId;
    const stableExpected = grant.repositoryBindings.filter((binding) => binding.snapshotRepositoryId !== primaryRepositoryId);
    const stableActual = currentRepositoryBindings.filter((binding) => binding.snapshotRepositoryId !== primaryRepositoryId);
    if (!sameRepositoryBindings(stableExpected, stableActual)) {
      return "A secondary workspace repository changed during execution.";
    }
    if (exactSource) {
      const currentRetrievalBindings = source.retrievalBindings;
      if (!sameRetrievalBindings(grant.retrievalBindings, currentRetrievalBindings)) {
        // Retrieval evidence is part of the exact approval record, but it is not
        // execution authority. Provider indexing or additional post-approval
        // discovery may legitimately change the current retrieval revision while
        // the approved source baseline and task constraints remain exact.
        // Preserve the drift as durable provenance instead of revoking an
        // otherwise valid untouched execution grant.
        const currentDigest = retrievalBindingDigest(currentRetrievalBindings);
        const observationKey = `executionRetrievalObservation:${grant.id}`;
        if (this.ledger.getState<string>(observationKey) !== currentDigest) {
          this.ledger.setState(observationKey, currentDigest);
          this.ledger.append({
            kind: "execution.retrieval_drift_observed",
            actor: "system",
            repositorySnapshot: snapshot,
            taskId: grant.taskId,
            payload: {
              executionGrantId: grant.id,
              approvedRetrievalDigest: retrievalBindingDigest(grant.retrievalBindings),
              currentRetrievalDigest: currentDigest,
              approvedBindingCount: grant.retrievalBindings.length,
              currentBindingCount: currentRetrievalBindings.length,
              authorityChanged: false,
            },
          });
        }
      }
    }
    if (!exactSource && grant.repositorySnapshot.vcs !== "none" && grant.repositorySnapshot.headCommit !== "unborn") {
      try {
        this.repository.diffFrom(grant.repositorySnapshot.sourceBaseCommit ?? grant.repositorySnapshot.headCommit);
      } catch {
        return "Approved source baseline is no longer reachable during execution resume.";
      }
    }
    const mapping = this.ledger.getTaskMapping(grant.planTaskId);
    if (mapping === undefined || mapping.provider !== this.provider.name || mapping.providerTaskId !== grant.taskId
      || mapping.planHash !== grant.planHash) return "Approved task mapping changed during execution resume.";
    const task = await this.provider.get(grant.taskId);
    if (task === undefined) return "Execution task is unavailable during execution resume.";
    if (task.status !== "in_progress") return `Execution task status changed to ${task.status}.`;
    if (grant.executionBaseline !== undefined
      && (grant.executionBaseline.taskOwner ?? "") !== (task.assignee ?? "")) {
      return "Execution task ownership changed during execution resume.";
    }
    return undefined;
  }
}
