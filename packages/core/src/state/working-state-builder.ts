import type {
  WorkingState,
  LedgerEvent,
  ParsedPlan,
  ApprovedTaskConstraint,
  PlanTask,
  RepositorySnapshot,
  TaskRecord,
  WorkflowMode,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { TaskProvider } from "../tasks/task-provider.ts";
import type { ValidationService } from "../validation/validation-service.ts";
import type { CodeService } from "../code/service.ts";
import type { CodeProviderStatus, CodeSearchFocus, CodeSearchHit, CodeWorkspace } from "../code/types.ts";
import type { RetrievalRevisionBinding } from "../code/retrieval.ts";
import { RepositoryStatePlanner } from "./repository-state-planner.ts";
import { workingStateToMarkdown } from "./working-state-markdown.ts";
import { newId, nowIso } from "../util/ids.ts";
import { repositoryRevisionBinding, sameRepositoryBindings } from "../repository/revision-binding.ts";
import { canonicalSymbolIdentifier } from "../code/service-support.ts";

export interface WorkingStateBuildRequest {
  mode: WorkflowMode;
  snapshot: RepositorySnapshot;
  workspace?: CodeWorkspace;
  plan?: ParsedPlan;
  explicitTaskId?: string;
  changedPaths?: string[];
  maximumReadyTasks?: number;
  maximumRecentEvents?: number;
  maximumDurableEvents?: number;
  maximumCodeEvidence?: number;
}

interface TaskSelection {
  task?: TaskRecord;
  source: WorkingState["taskSelection"]["source"];
  rationale: string;
  omission?: string;
}

export class WorkingStateBuilder {
  private readonly provider: TaskProvider;
  private readonly ledger: SqliteLedger;
  private readonly code: CodeService | undefined;
  private readonly validation: ValidationService | undefined;
  private readonly repositoryStatePlanner = new RepositoryStatePlanner();

  constructor(provider: TaskProvider, ledger: SqliteLedger, code?: CodeService, validation?: ValidationService) {
    this.provider = provider;
    this.ledger = ledger;
    this.code = code;
    this.validation = validation;
  }

  async build(request: WorkingStateBuildRequest): Promise<WorkingState> {
    const omissions: string[] = [];
    const retrievalExplanation: string[] = [];
    const approvedPlanHash = this.ledger.getState<string>("approvedPlanHash");
    const planObjective = normalizeOptional(this.ledger.getState<string>("planObjective"));
    const providerReadyTasks = await this.readyTasks(request.maximumReadyTasks ?? 10, omissions);
    const readyTasks = this.scopeReadyTasks(providerReadyTasks, request.plan, approvedPlanHash);
    if (readyTasks.length !== providerReadyTasks.length) {
      retrievalExplanation.push(
        `Excluded ${providerReadyTasks.length - readyTasks.length} ready task(s) that do not map to the approved plan.`,
      );
    }
    const selection = await this.selectTask(request.explicitTaskId, readyTasks, request.plan, approvedPlanHash);
    if (selection.omission !== undefined) omissions.push(selection.omission);
    retrievalExplanation.push(selection.rationale);

    const activeTask = selection.task;
    const planTask = this.findPlanTask(request.plan, activeTask);
    const taskDependencies = await this.taskDependencies(activeTask, omissions);
    const taskBlockers = taskDependencies.filter((task) => task.status !== "closed");
    const taskConstraints = this.activeTaskConstraints();
    const activeExecutionGrant = this.ledger.getActiveExecutionGrant();
    const executionGrant = activeExecutionGrant ?? this.ledger.listExecutionGrants()[0];
    const workflowRun = this.ledger.getCurrentWorkflowRun();
    const planApproval = executionGrant === undefined
      ? this.ledger.listPlanApprovals()[0]
      : this.ledger.getPlanApproval(executionGrant.planApprovalId);
    const reconciliationTransaction = executionGrant === undefined
      ? (planApproval === undefined ? undefined : this.ledger.getApprovalReconciliationTransaction(planApproval.id))
      : this.ledger.getReconciliationTransaction(executionGrant.reconciliationTransactionId);
    const evidenceTaskId = executionGrant?.taskId ?? activeTask?.id;
    const executionEvidence = evidenceTaskId === undefined
      ? []
      : this.ledger.listExecutionEvidence({ taskId: evidenceTaskId, limit: 20 });
    const focusedValidationSelections = evidenceTaskId === undefined
      ? []
      : this.validation?.listFocusedSelections({ taskId: evidenceTaskId, limit: 10 }) ?? [];
    const recentEvents = this.ledger.listEvents({ limit: request.maximumRecentEvents ?? 30 });
    const durableLimit = request.maximumDurableEvents ?? 20;
    const corrections = this.relevantEvents(
      this.ledger.listEvents({ kind: "correction", limit: durableLimit * 3 }),
      activeTask,
      durableLimit,
    );
    const findings = this.relevantEvents(
      this.ledger.listEvents({ kinds: ["finding", "decision"], limit: durableLimit * 3 }),
      activeTask,
      durableLimit,
    );
    const manualEdits = this.relevantEvents(
      this.ledger.listEvents({ kind: "manual_edit.completed", limit: durableLimit * 3 }),
      activeTask,
      durableLimit,
    );

    const planningRetrieval = this.code?.retrievalStatus();
    let planningCodeStatus: CodeProviderStatus | undefined;
    if (this.code !== undefined && request.workspace !== undefined) {
      try {
        planningCodeStatus = await this.code.status(undefined, request.workspace);
      } catch (error) {
        omissions.push(`Code provider status unavailable: ${errorMessage(error)}`);
      }
    }
    const planningRepositoryIds = new Set(request.workspace?.repositories.map((repository) => repository.id) ?? []);
    const scopedPlanningEvidence = planningRetrieval?.evidence.filter((item) => {
      const provenance = item.provenance[0];
      return provenance !== undefined
        && provenance.workspaceId === request.workspace?.id
        && planningRepositoryIds.has(provenance.repositoryId);
    }) ?? [];
    const semanticDiscoveryComplete = request.workspace !== undefined && planningCodeStatus !== undefined
      ? planningRetrieval?.semanticDiscoveryBindings.some((binding) =>
          bindingMatchesWorkspace(binding, request.workspace!, planningCodeStatus!)) ?? false
      : false;
    const repositoryPlan = this.repositoryStatePlanner.plan({
      mode: request.mode,
      ...(planObjective === undefined ? {} : { planObjective }),
      ...(activeTask === undefined ? {} : { activeTask }),
      ...(planTask === undefined ? {} : { planTask }),
      ...(request.plan === undefined ? {} : { plan: request.plan }),
      ...(planningRetrieval === undefined ? {} : {
        evidence: {
          semanticDiscoveryComplete,
          resolvedIdentifiers: planningRetrieval.inventory.resolvedSymbols,
          unresolvedIdentifiers: planningRetrieval.unresolvedSymbolScopes
            .filter((item) => item.workspaceId === request.workspace?.id
              && item.repositoryIds.some((repositoryId) => planningRepositoryIds.has(repositoryId)))
            .map((item) => item.symbol),
          knownPaths: scopedPlanningEvidence.flatMap((item) => item.kind === "hit" ? [(item.value as { path: string }).path] : []),
        },
      }),
    });
    retrievalExplanation.push(...repositoryPlan.explanation);

    const retrievalQueries: WorkingState["retrievalQueries"] = [];
    const codeEvidence: WorkingState["codeEvidence"] = [];
    const initialRetrievalStatus = this.code?.retrievalStatus();
    const initialRepositoryIds = new Set(request.workspace?.repositories.map((repository) => repository.id) ?? []);
    const initialEvidenceCount = initialRetrievalStatus?.evidence.filter((item) => {
      const provenance = item.provenance[0];
      return provenance !== undefined
        && provenance.workspaceId === request.workspace?.id
        && initialRepositoryIds.has(provenance.repositoryId);
    }).length ?? 0;
    if (initialEvidenceCount > 0) {
      retrievalExplanation.push(
        `Consulted retrieval session ${initialRetrievalStatus!.sessionId} with ${initialEvidenceCount} scoped compact evidence record(s) before executing the repository plan.`,
      );
    }
    const seenEvidence = new Set<string>();
    const maximumCodeEvidence = request.maximumCodeEvidence ?? 8;
    if (repositoryPlan.queries.length > 0 && this.code !== undefined && request.workspace !== undefined) {
      for (const query of repositoryPlan.queries) {
        try {
          const results = query.operation === "search"
            ? await this.code.search({
                workspace: request.workspace,
                text: query.text,
                mode: "semantic",
                focus: providerFocus(query.focus),
                ...(query.literalHints.length === 0 ? {} : { literalHints: query.literalHints }),
                limit: query.limit,
              })
            : await this.code.symbols({
                workspace: request.workspace,
                text: query.text,
                limit: query.limit,
              });
          const warnings = [...new Set(results.flatMap((hit) => hit.provenance.warnings ?? []))];
          const degraded = results.some((hit) => hit.provenance.degraded === true);
          retrievalQueries.push({
            purpose: query.purpose,
            text: query.text,
            focus: query.focus,
            literalHints: query.literalHints,
            resultCount: results.length,
            degraded,
            warnings,
          });
          retrievalExplanation.push(
            `Repository query ${query.purpose} returned ${results.length} result(s)`
            + (degraded ? " in degraded mode." : "."),
          );
          const retrievalDecision = this.code.retrievalStatus().lastDecision;
          if (retrievalDecision !== undefined) {
            retrievalExplanation.push(
              `Retrieval decision for ${query.purpose}: ${retrievalDecision.kind} — ${retrievalDecision.reason}`,
            );
          }
          for (const hit of results) {
            if (codeEvidence.length >= maximumCodeEvidence) break;
            const key = evidenceKey(hit);
            if (seenEvidence.has(key)) continue;
            seenEvidence.add(key);
            codeEvidence.push({
              provider: hit.provenance.provider.name,
              repositoryId: hit.repositoryId,
              path: hit.path,
              ...(hit.language === undefined ? {} : { language: hit.language }),
              ...(hit.symbol === undefined ? {} : { symbol: hit.symbol }),
              ...(hit.startLine === undefined ? {} : { startLine: hit.startLine }),
              ...(hit.endLine === undefined ? {} : { endLine: hit.endLine }),
              ...(hit.preview === undefined ? {} : { preview: hit.preview }),
              queryPurpose: query.purpose,
              retrievalMethods: hit.retrievalMethods,
              degraded: hit.provenance.degraded === true,
              warnings: hit.provenance.warnings ?? [],
              indexState: hit.provenance.indexState,
            });
          }
        } catch (error) {
          const message = `Code provider unavailable for ${query.purpose}: ${errorMessage(error)}`;
          omissions.push(message);
          retrievalQueries.push({
            purpose: query.purpose,
            text: query.text,
            focus: query.focus,
            literalHints: query.literalHints,
            resultCount: 0,
            degraded: true,
            warnings: [message],
          });
        }
      }
    } else if (repositoryPlan.queries.length > 0) {
      omissions.push("Repository retrieval was planned but no code service or workspace was available.");
    }

    const retrievalStatus = this.code?.retrievalStatus();
    const retrievalRepositoryIds = new Set(request.workspace?.repositories.map((repository) => repository.id) ?? []);
    const scopedDecisions = retrievalStatus?.decisions.filter((item) =>
      item.workspaceId === request.workspace?.id
      && item.repositoryIds.every((repositoryId) => retrievalRepositoryIds.has(repositoryId))) ?? [];
    const scopedQueryDigests = new Set(scopedDecisions.map((item) => item.queryDigest));
    const scopedInventory: NonNullable<WorkingState["retrievalSession"]>["inventory"] = retrievalStatus?.evidence.flatMap((item) => {
      if (item.kind !== "hit" || item.provenance.length === 0) return [];
      const value = item.value as Omit<CodeSearchHit, "provenance" | "provenanceObservations">;
      const provenance = item.provenance[0]!;
      if (
        request.workspace === undefined
        || provenance.workspaceId !== request.workspace.id
        || !retrievalRepositoryIds.has(value.repositoryId)
      ) return [];
      return [{
        provider: provenance.provider.name,
        providerInstance: provenance.provider.instanceId,
        workspaceId: provenance.workspaceId,
        repositoryId: value.repositoryId,
        path: value.path,
        ...(value.symbol === undefined ? {} : { symbol: value.symbol }),
        ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
        ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
        queryDigests: item.queryDigests,
        retrievalMethods: value.retrievalMethods,
        freshness: provenance.freshness ?? (provenance.indexState === "ready" ? "current" : "unknown"),
      }];
    }) ?? [];
    const scopedUnresolvedSymbols = retrievalStatus?.unresolvedSymbolScopes
      .filter((item) => item.workspaceId === request.workspace?.id
        && item.repositoryIds.every((repositoryId) => retrievalRepositoryIds.has(repositoryId)))
      .map((item) => item.symbol) ?? [];
    const retrievalSession: WorkingState["retrievalSession"] = retrievalStatus === undefined
      ? undefined
      : {
          id: retrievalStatus.sessionId,
          inventory: scopedInventory,
          knownPaths: [...new Set(scopedInventory.map((item) => item.path))].sort(),
          resolvedSymbols: [...new Set(scopedInventory.flatMap((item) => {
            const symbol = canonicalSymbolIdentifier(item.symbol);
            return symbol === undefined ? [] : [symbol];
          }))].sort(),
          unresolvedSymbols: [...new Set(scopedUnresolvedSymbols)].sort(),
          freshness: scopedInventory.length === 0
            ? "unknown"
            : scopedInventory.every((item) => item.freshness === "current") ? "current" : "possibly_stale",
          bindings: retrievalStatus.bindings.filter((binding) => binding.workspaceId === request.workspace?.id),
          budget: retrievalStatus.budget,
          telemetry: retrievalStatus.telemetry,
          persistence: retrievalStatus.persistence,
          diagnostics: retrievalStatus.diagnostics.filter((item) => item.queryDigest === undefined || scopedQueryDigests.has(item.queryDigest)),
          invalidations: retrievalStatus.invalidations.filter((item) => item.affectedQueryDigests.some((digest) => scopedQueryDigests.has(digest))),
          decisions: scopedDecisions,
        };

    const validationEvidence = this.validation?.latestCurrent(request.snapshot).map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      durationMs: item.durationMs,
    })) ?? [];
    const validationSummaries = this.validation?.summaries(
      request.snapshot,
      request.changedPaths ?? [],
      activeTask?.id,
    ) ?? { current: [], stale: [] };
    const taskClosure = activeExecutionGrant === undefined || this.validation === undefined
      ? { ready: false, blockers: [], required: [], missing: [], stale: [], failed: [], reason: "No active task exists." }
      : this.validation.closureReadiness(request.snapshot, activeExecutionGrant.taskId, activeExecutionGrant.id);
    const nextAction = describeNextAction({
      ...(request.plan === undefined ? {} : { planPath: request.plan.path }),
      ...(workflowRun === undefined ? {} : { workflowCheckpoint: workflowRun.checkpoint }),
      ...(planApproval === undefined ? {} : { planApproval }),
      ...(reconciliationTransaction === undefined ? {} : { reconciliationTransaction }),
      ...(executionGrant === undefined ? {} : { executionGrant }),
      taskClosure,
      readyTasks,
    });

    this.persistTaskSelection(selection, request.snapshot);
    if (request.plan === undefined) {
      omissions.push("No plan document was supplied to the working state builder.");
    } else if (planTask === undefined && activeTask !== undefined) {
      omissions.push("The active provider task could not be mapped to a plan task.");
    } else if (planTask !== undefined) {
      retrievalExplanation.push(`Included reviewed-plan task ${planTask.id}.`);
    }
    retrievalExplanation.push(
      `Included ${taskDependencies.length} direct dependency record(s), including ${taskBlockers.length} blocker(s).`,
    );
    retrievalExplanation.push(`Included ${taskConstraints.length} reviewed task constraint record(s).`);
    retrievalExplanation.push(
      `Included ${corrections.length} correction(s), ${findings.length} finding/decision record(s), `
      + `and ${manualEdits.length} ManualEdit record(s).`,
    );
    retrievalExplanation.push(
      `Included ${codeEvidence.length} normalized code result(s) and ${validationEvidence.length} current validation record(s).`,
    );

    return {
      stateId: newId("state"),
      generatedAt: nowIso(),
      snapshot: request.snapshot,
      mode: request.mode,
      ...(planObjective === undefined ? {} : { planObjective }),
      ...(activeTask === undefined ? {} : { activeTask }),
      taskSelection: { source: selection.source, rationale: selection.rationale },
      readyTasks,
      taskDependencies,
      taskBlockers,
      ...(approvedPlanHash === undefined ? {} : { approvedPlanHash }),
      ...(planTask === undefined ? {} : { planTask }),
      ...(executionGrant === undefined ? {} : { executionGrant }),
      ...(workflowRun === undefined ? {} : { workflowCheckpoint: workflowRun.checkpoint }),
      ...(planApproval === undefined ? {} : { planApproval }),
      ...(reconciliationTransaction === undefined ? {} : { reconciliationTransaction }),
      taskConstraints,
      executionEvidence,
      focusedValidationSelections,
      currentValidationEvidence: validationSummaries.current,
      staleValidationEvidence: validationSummaries.stale,
      taskClosure,
      nextAction,
      corrections,
      findings,
      manualEdits,
      recentEvents,
      retrievalQueries,
      ...(retrievalSession === undefined ? {} : { retrievalSession }),
      codeEvidence,
      validationEvidence,
      omissions,
      retrievalExplanation,
    };
  }

  toMarkdown(state: WorkingState): string {
    return workingStateToMarkdown(state);
  }

  private async readyTasks(limit: number, omissions: string[]): Promise<TaskRecord[]> {
    try {
      return (await this.provider.ready())
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
        .slice(0, limit);
    } catch (error) {
      omissions.push(`Task provider ${this.provider.name} is unavailable: ${errorMessage(error)}`);
      return [];
    }
  }

  private async selectTask(
    explicitTaskId: string | undefined,
    readyTasks: TaskRecord[],
    plan: ParsedPlan | undefined,
    approvedPlanHash: string | undefined,
  ): Promise<TaskSelection> {
    if (explicitTaskId !== undefined) {
      try {
        const task = await this.provider.get(explicitTaskId);
        if (task === undefined) {
          const rationale = `Explicit task ${explicitTaskId} was not found.`;
          return { source: "none", rationale, omission: rationale };
        }
        return { task, source: "explicit", rationale: `Selected explicitly requested task ${task.id}.` };
      } catch (error) {
        const rationale = `Unable to read explicit task ${explicitTaskId}: ${errorMessage(error)}`;
        return { source: "none", rationale, omission: rationale };
      }
    }

    const approvedPlan = plan !== undefined && approvedPlanHash === plan.hash;
    const currentTaskId = this.ledger.getState<string>("currentTaskId");
    if (currentTaskId !== undefined) {
      try {
        const current = await this.provider.get(currentTaskId);
        if (
          current !== undefined
          && (current.status === "open" || current.status === "in_progress")
          && (!approvedPlan || this.findPlanTask(plan, current) !== undefined)
        ) {
          return { task: current, source: "resumed", rationale: `Resumed current task ${current.id} from durable task state.` };
        }
      } catch (error) {
        return {
          source: "none",
          rationale: `Unable to resume current task ${currentTaskId}: ${errorMessage(error)}`,
          omission: `Unable to resume current task ${currentTaskId}: ${errorMessage(error)}`,
        };
      }
    }

    const planOrder = new Map(plan?.tasks.map((task, index) => [task.id, index]) ?? []);
    const ready = [...readyTasks].sort((left, right) => {
      const priority = left.priority - right.priority;
      if (priority !== 0) return priority;
      const leftPlan = this.findPlanTask(plan, left);
      const rightPlan = this.findPlanTask(plan, right);
      const planDifference = (leftPlan === undefined ? Number.MAX_SAFE_INTEGER : planOrder.get(leftPlan.id) ?? Number.MAX_SAFE_INTEGER)
        - (rightPlan === undefined ? Number.MAX_SAFE_INTEGER : planOrder.get(rightPlan.id) ?? Number.MAX_SAFE_INTEGER);
      return planDifference !== 0 ? planDifference : left.id.localeCompare(right.id);
    })[0];
    if (ready !== undefined) {
      return {
        task: ready,
        source: "ready",
        rationale: approvedPlan
          ? `Selected highest-priority ready task ${ready.id} within approved plan ${plan.hash}.`
          : `Selected highest-priority ready task ${ready.id} from durable task state.`,
      };
    }
    const omission = "No active or ready task was available from the configured task provider.";
    return { source: "none", rationale: omission, omission };
  }

  private scopeReadyTasks(
    readyTasks: TaskRecord[],
    plan: ParsedPlan | undefined,
    approvedPlanHash: string | undefined,
  ): TaskRecord[] {
    if (plan === undefined || approvedPlanHash !== plan.hash) return readyTasks;
    return readyTasks.filter((task) => this.findPlanTask(plan, task) !== undefined);
  }

  private async taskDependencies(task: TaskRecord | undefined, omissions: string[]): Promise<TaskRecord[]> {
    if (task === undefined || task.dependencies.length === 0) return [];
    const dependencies: TaskRecord[] = [];
    for (const dependencyId of task.dependencies) {
      try {
        const dependency = await this.provider.get(dependencyId);
        if (dependency === undefined) omissions.push(`Dependency ${dependencyId} for task ${task.id} was not found.`);
        else dependencies.push(dependency);
      } catch (error) {
        omissions.push(`Unable to read dependency ${dependencyId}: ${errorMessage(error)}`);
      }
    }
    return dependencies.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  private findPlanTask(plan: ParsedPlan | undefined, task: TaskRecord | undefined): PlanTask | undefined {
    if (plan === undefined || task === undefined) return undefined;
    if (task.planTaskId !== undefined) return plan.tasks.find((candidate) => candidate.id === task.planTaskId);
    const mapping = this.ledger.listTaskMappings().find((candidate) => candidate.providerTaskId === task.id);
    return mapping === undefined ? undefined : plan.tasks.find((candidate) => candidate.id === mapping.planTaskId);
  }

  private activeTaskConstraints(): ApprovedTaskConstraint[] {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return [];
    const approval = this.ledger.getPlanApproval(grant.planApprovalId);
    return approval?.taskConstraints.filter((constraint) => constraint.planTaskId === grant.planTaskId) ?? [];
  }

  private relevantEvents(events: LedgerEvent[], activeTask: TaskRecord | undefined, limit: number): LedgerEvent[] {
    return events
      .filter((event) => activeTask === undefined || event.taskId === undefined || event.taskId === activeTask.id)
      .slice(0, limit);
  }

  private persistTaskSelection(selection: TaskSelection, snapshot: RepositorySnapshot): void {
    const previousTaskId = this.ledger.getState<string>("currentTaskId");
    if (selection.task === undefined) return;
    this.ledger.setState("currentTaskId", selection.task.id);
    if (previousTaskId === selection.task.id) return;
    this.ledger.append({
      kind: "task.selected",
      actor: "system",
      taskId: selection.task.id,
      repositorySnapshot: snapshot,
      payload: {
        provider: this.provider.name,
        source: selection.source,
        rationale: selection.rationale,
      },
    });
  }
}

function bindingMatchesWorkspace(
  binding: RetrievalRevisionBinding,
  workspace: CodeWorkspace,
  status: CodeProviderStatus,
): boolean {
  if (!status.available || !status.healthy || status.indexState !== "ready" || status.degraded === true || status.indexRevision === undefined) return false;
  if (binding.workspaceId !== workspace.id) return false;
  if (JSON.stringify(binding.provider) !== JSON.stringify(status.identity)) return false;
  if (binding.indexRevision !== status.indexRevision) return false;
  return sameRepositoryBindings(
    binding.repositories,
    workspace.repositories.map((repository) => repositoryRevisionBinding(repository.id, repository.snapshot)),
  );
}

function providerFocus(focus: WorkingState["retrievalQueries"][number]["focus"]): CodeSearchFocus {
  return focus === "mixed" ? "auto" : focus;
}

function evidenceKey(hit: CodeSearchHit): string {
  return `${hit.repositoryId}:${hit.path}:${hit.startLine ?? ""}:${hit.endLine ?? ""}:${hit.symbol ?? ""}`;
}

function describeNextAction(input: {
  planPath?: string;
  workflowCheckpoint?: WorkingState["workflowCheckpoint"];
  planApproval?: WorkingState["planApproval"];
  reconciliationTransaction?: WorkingState["reconciliationTransaction"];
  executionGrant?: WorkingState["executionGrant"];
  taskClosure: WorkingState["taskClosure"];
  readyTasks: TaskRecord[];
}): string {
  if (input.reconciliationTransaction?.preview.conflicts.length) {
    return `Resolve reconciliation conflicts: ${input.reconciliationTransaction.preview.conflicts.join("; ")}`;
  }
  if (input.executionGrant?.status === "active") {
    if (input.taskClosure.ready) return `Close active task ${input.executionGrant.taskId} explicitly.`;
    if (input.workflowCheckpoint === "validating") return `Run required focused validation: ${input.taskClosure.reason}`;
    return `Continue implementing active task ${input.executionGrant.taskId}, then validate focused changes.`;
  }
  if (input.executionGrant?.status === "revoked" && input.readyTasks.length === 0) {
    return `Prepare a fresh exact transaction to resume task ${input.executionGrant.taskId}, or explicitly close/defer it in the task provider.`;
  }
  if (input.planApproval?.status === "prepared") {
    return `Inspect and explicitly approve transaction ${input.planApproval.id} with digest ${input.planApproval.reconciliationDigest}.`;
  }
  if (input.workflowCheckpoint === "reviewed") return "Prepare and approve the exact reviewed plan transaction.";
  if (input.workflowCheckpoint !== undefined && ["drafting", "review_pending", "reviewing"].includes(input.workflowCheckpoint)) {
    return `Complete ManualEdit review of ${input.planPath ?? "the plan document"}.`;
  }
  if (input.planApproval?.status === "approved" && input.readyTasks.length > 0) {
    return `Explicitly execute one approved-plan task: ${input.readyTasks.map((task) => task.id).join(", ")}.`;
  }
  if (input.readyTasks.length > 0) return `Select a ready task: ${input.readyTasks.map((task) => task.id).join(", ")}.`;
  return `Start or resume planning in ${input.planPath ?? "the plan document"}.`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
