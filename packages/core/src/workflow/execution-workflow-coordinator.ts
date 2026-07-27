import type {
  ExecutionGrant,
  ExecutionPreparation,
  ExecutionTransition,
  PlanApproval,
  ReconciliationTransaction,
  TaskProviderIdentity,
  TaskRecord,
  TaskStartTransition,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { parsePlanFile } from "../planning/plan-parser.ts";
import { PlanReconciler } from "../planning/plan-reconciler.ts";
import type { RepositoryProvider } from "../repository/repository-provider.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";
import { newId, nowIso } from "../util/ids.ts";

export interface ExecutionWorkflowCoordinatorOptions {
  planPath: string;
  ledger: SqliteLedger;
  provider: TaskProvider;
  repository: RepositoryProvider;
}

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

  constructor(options: ExecutionWorkflowCoordinatorOptions) {
    this.planPath = options.planPath;
    this.ledger = options.ledger;
    this.provider = options.provider;
    this.repository = options.repository;
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
    const snapshot = this.repository.snapshot();
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
      },
    });
    return { approval, transaction, reconciliation };
  }

  async approveAndApply(planApprovalId: string, confirmed: boolean): Promise<ExecutionTransition> {
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

    const plan = parsePlanFile(this.planPath);
    const current = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    const snapshot = this.repository.snapshot();
    const mismatch = this.preparationMismatch(approval, plan.hash, current.provider, current.digest, snapshot);
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
      applied = await new PlanReconciler(this.provider, this.ledger).apply(plan, current);
      if (!applied.applied || applied.conflicts.length > 0) {
        throw new Error(`Reconciliation did not apply: ${applied.conflicts.join("; ")}`);
      }
      const converged = await new PlanReconciler(this.provider, this.ledger).preview(plan);
      if (converged.conflicts.length > 0 || converged.operations.length > 0) {
        throw new Error("Reconciliation did not converge after apply.");
      }
      const task = await this.claimReadyTask(plan.hash, plan.tasks.map((item) => item.id));
      const approved: PlanApproval = { ...accepted, status: "approved" };
      const grant = this.executionGrant(approved, transaction.id, task);
      applying = { ...applying, status: "applied", preview: applied, updatedAt: nowIso() };
      this.ledger.activateExecution({ approval: approved, transaction: applying, grant });
      this.ledger.setWorkflowCheckpoint("executing");
      return { approval: approved, transaction: applying, reconciliation: applied, task, executionGrant: grant };
    } catch (error) {
      this.ledger.failExecutionApplication(accepted, applying, errorMessage(error));
      throw error;
    }
  }

  async startNextTask(confirmed: boolean, requestedTaskId?: string): Promise<TaskStartTransition | undefined> {
    const active = this.ledger.getActiveExecutionGrant();
    const previous = active ?? this.ledger.listExecutionGrants().find((grant) => grant.status === "revoked");
    if (previous === undefined) throw new Error("No prior approved execution grant exists for task continuation.");
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
      const grant = this.executionGrant(approval, transaction.id, task);
      this.ledger.activateExecution({ approval, transaction, grant });
      this.ledger.setWorkflowCheckpoint("executing");
      return { task, transaction, executionGrant: grant };
    } catch (error) {
      this.ledger.failExecutionApplication(approval, applying, errorMessage(error));
      throw error;
    }
  }

  cancel(reason: string): ExecutionGrant | undefined {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return undefined;
    return this.ledger.invalidateExecutionGrant(grant.id, { status: "revoked", reason });
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
    this.ledger.setWorkflowCheckpoint("executing");
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
  ): string | undefined {
    if (approval.planHash !== planHash) return "plan hash changed";
    if (!sameProvider(approval.provider, provider)) return "provider identity changed";
    if (approval.reconciliationDigest !== reconciliationDigest) return "reconciliation digest changed";
    if (approval.workspaceId !== snapshot.workspaceId) return "workspace changed";
    if (approval.repositoryId !== snapshot.repositoryId) return "repository changed";
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

  private executionGrant(approval: PlanApproval, transactionId: string, task: TaskRecord): ExecutionGrant {
    if (task.planTaskId === undefined) throw new Error(`Task ${task.id} has no approved plan identity.`);
    return {
      id: newId("execution"),
      status: "active",
      planApprovalId: approval.id,
      reconciliationTransactionId: transactionId,
      planHash: approval.planHash,
      reconciliationDigest: approval.reconciliationDigest,
      provider: approval.provider,
      workspaceId: approval.workspaceId,
      repositoryId: approval.repositoryId,
      taskId: task.id,
      planTaskId: task.planTaskId,
      issuedAt: nowIso(),
    };
  }

  private async invalidReason(grant: ExecutionGrant): Promise<string | undefined> {
    const approval = this.ledger.getPlanApproval(grant.planApprovalId);
    if (approval === undefined || approval.status !== "approved") return "Plan approval is unavailable or changed.";
    const plan = parsePlanFile(this.planPath);
    if (plan.hash !== grant.planHash || approval.planHash !== grant.planHash) return "Plan hash changed after execution approval.";
    const status = await this.provider.status();
    if (!status.available || !status.initialized) return "Task provider is unavailable during execution resume.";
    if (!sameProvider(grant.provider, providerIdentity(this.provider.name, status.version))) return "Task provider identity changed during execution resume.";
    const reconciliation = await new PlanReconciler(this.provider, this.ledger).preview(plan);
    if (!sameProvider(reconciliation.provider, grant.provider)
      || reconciliation.conflicts.length > 0 || reconciliation.operations.length > 0) {
      return "Task provider reconciliation changed during execution resume.";
    }
    const snapshot = this.repository.snapshot();
    if (snapshot.workspaceId !== grant.workspaceId) return "Workspace changed during execution resume.";
    if (snapshot.repositoryId !== grant.repositoryId) return "Repository changed during execution resume.";
    const mapping = this.ledger.getTaskMapping(grant.planTaskId);
    if (mapping === undefined || mapping.provider !== this.provider.name || mapping.providerTaskId !== grant.taskId
      || mapping.planHash !== grant.planHash) return "Approved task mapping changed during execution resume.";
    const task = await this.provider.get(grant.taskId);
    if (task === undefined) return "Execution task is unavailable during execution resume.";
    if (task.status !== "in_progress") return `Execution task status changed to ${task.status}.`;
    return undefined;
  }
}
