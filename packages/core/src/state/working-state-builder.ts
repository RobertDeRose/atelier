import type {
  WorkingState,
  LedgerEvent,
  ParsedPlan,
  PermissionGrant,
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
import { newId, nowIso } from "../util/ids.ts";

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
    const permissions = this.activePermissions(this.ledger.listGrants());
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const workflowRun = this.ledger.getCurrentWorkflowRun();
    const planApproval = executionGrant === undefined
      ? undefined
      : this.ledger.getPlanApproval(executionGrant.planApprovalId);
    const reconciliationTransaction = executionGrant === undefined
      ? undefined
      : this.ledger.getReconciliationTransaction(executionGrant.reconciliationTransactionId);
    const executionEvidence = activeTask === undefined
      ? []
      : this.ledger.listExecutionEvidence({ taskId: activeTask.id, limit: 20 });
    const focusedValidationSelections = activeTask === undefined
      ? []
      : this.validation?.listFocusedSelections({ taskId: activeTask.id, limit: 10 }) ?? [];
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
          resolvedIdentifiers: [...new Set(scopedPlanningEvidence.flatMap((item) =>
            item.kind === "hit" && "symbol" in item.value && typeof item.value.symbol === "string"
              ? [item.value.symbol]
              : []))],
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
          resolvedSymbols: [...new Set(scopedInventory.flatMap((item) => item.symbol === undefined ? [] : [item.symbol]))].sort(),
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
    const taskClosure = executionGrant === undefined || this.validation === undefined
      ? { ready: false, required: [], missing: [], stale: [], failed: [], reason: "No active execution grant exists." }
      : this.validation.closureReadiness(request.snapshot, executionGrant.taskId, executionGrant.id);

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
    retrievalExplanation.push(`Included ${permissions.length} active permission grant(s).`);
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
      permissions,
      executionEvidence,
      focusedValidationSelections,
      currentValidationEvidence: validationSummaries.current,
      staleValidationEvidence: validationSummaries.stale,
      taskClosure,
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
    const lines: string[] = [
      "# Atelier Working State",
      "",
      `- Mode: ${state.mode}`,
      `- Repository: ${state.snapshot.vcs} workspace ${state.snapshot.workspaceId}`
      + (state.snapshot.vcs === "jj"
        ? ` / change ${state.snapshot.changeId ?? "unknown"} / operation ${state.snapshot.operationId ?? "unknown"}`
        : ` / commit ${state.snapshot.headCommit}`)
      + ` / dirty generation ${state.snapshot.dirtyGeneration}`,
      `- Working state: ${state.stateId}`,
      `- Task selection: ${state.taskSelection.source} — ${state.taskSelection.rationale}`,
      `- Execution grant: ${state.executionGrant === undefined
        ? "none"
        : `${state.executionGrant.id} (${state.executionGrant.status}) for ${state.executionGrant.taskId}`}`,
      `- Workflow checkpoint: ${state.workflowCheckpoint ?? "none"}`,
      `- Plan approval: ${state.planApproval?.id ?? "none"}`,
      `- Reconciliation: ${state.reconciliationTransaction?.id ?? "none"}`,
      `- Task closure: ${state.taskClosure.ready ? "ready" : "blocked"} — ${state.taskClosure.reason}`,
    ];

    if (state.planObjective) lines.push(`- Planning objective: ${state.planObjective}`);
    if (state.approvedPlanHash) lines.push(`- Approved plan: ${state.approvedPlanHash}`);
    if (state.activeTask) {
      lines.push("", "## Current task", "", `**${state.activeTask.id}: ${state.activeTask.title}**`, "");
      if (state.activeTask.description) lines.push(state.activeTask.description, "");
      if (state.activeTask.acceptanceCriteria.length > 0) {
        lines.push("Completion and validation:");
        for (const criterion of state.activeTask.acceptanceCriteria) lines.push(`- ${criterion}`);
      }
    } else {
      lines.push("", "## Current task", "", "No task is currently selected.");
    }

    if (state.taskDependencies.length > 0) {
      lines.push("", "## Direct dependencies");
      for (const dependency of state.taskDependencies) {
        lines.push(`- ${dependency.id}: ${dependency.title} [${dependency.status}]`);
      }
    }
    if (state.taskBlockers.length > 0) {
      lines.push("", "## Blockers");
      for (const blocker of state.taskBlockers) lines.push(`- ${blocker.id}: ${blocker.title} [${blocker.status}]`);
    }

    if (state.planTask) {
      lines.push("", "## Reviewed plan scope", "", `Plan task: ${state.planTask.id} — ${state.planTask.title}`);
      if (state.planTask.scope.length > 0) lines.push("", "In scope:", ...state.planTask.scope.map((item) => `- ${item}`));
      if (state.planTask.outOfScope.length > 0) lines.push("", "Out of scope:", ...state.planTask.outOfScope.map((item) => `- ${item}`));
    }

    lines.push("", "## Active permissions");
    if (state.permissions.length === 0) lines.push("", "No mutation permissions are active.");
    for (const grant of state.permissions) lines.push(`- ${grant.permission} (${grant.scope}): ${grant.reason}`);

    lines.push("", "## Execution evidence");
    if (state.executionEvidence.length === 0) lines.push("", "No mutating tool execution evidence is recorded.");
    for (const item of state.executionEvidence) {
      lines.push(`- ${item.toolName}/${item.action}: ${item.status}; observed mutation: ${item.observedMutation}; changed paths: ${item.changedPaths.join(", ") || "none"}`);
    }

    lines.push("", "## Focused validation selection");
    if (state.focusedValidationSelections.length === 0) lines.push("", "No focused validation selection is recorded.");
    for (const selection of state.focusedValidationSelections) {
      lines.push(`- ${selection.id}: ${selection.noMatch ? "no matching focused validations" : selection.selected.map((item) => `${item.name}${item.required ? " (required)" : ""}`).join(", ")}`);
    }

    if (state.currentValidationEvidence.length > 0) {
      lines.push("", "## Current validation evidence");
      for (const item of state.currentValidationEvidence) lines.push(`- ${item.name}: ${item.status} (${item.durationMs} ms)`);
    }
    if (state.staleValidationEvidence.length > 0) {
      lines.push("", "## Stale validation evidence");
      for (const item of state.staleValidationEvidence) lines.push(`- ${item.name}: ${item.status}; ${item.staleReason ?? "repository fingerprint changed"}`);
    }

    if (state.retrievalSession !== undefined) {
      const session = state.retrievalSession;
      lines.push(
        "",
        "## Retrieval session",
        "",
        `- Session: ${session.id}`,
        `- Provider calls: ${session.telemetry.providerCalls}; cache hits: ${session.telemetry.cacheHits}; overlap reuses: ${session.telemetry.overlapReuses}`,
        `- Unique paths: ${session.telemetry.uniquePaths}; duplicate results removed: ${session.telemetry.duplicateResultsRemoved}; duplicate paths removed: ${session.telemetry.duplicatePathsRemoved}`,
        `- Bytes returned: ${session.telemetry.bytesReturned}; truncated: ${session.telemetry.truncated}`,
        `- Invalidations: ${session.telemetry.invalidations}`,
        `- Request budget: ${session.budget.providerRequestsUsed}/${session.budget.providerRequestsLimit}; result paths: ${session.budget.uniquePathsUsed}/${session.budget.uniquePathsLimit}; compact entries: ${session.budget.evidenceEntriesUsed}/${session.budget.evidenceEntriesLimit}`,
        `- Fetch budget: ${session.budget.fetchesUsed}/${session.budget.fetchesLimit}; bytes: ${session.budget.bytesUsed}/${session.budget.bytesLimit}`,
        `- Persisted sessions: ${session.persistence.retainedSessionsUsed}/${session.persistence.retainedSessionsLimit}; entries: ${session.persistence.entriesUsed}/${session.persistence.entriesLimit}; bytes: ${session.persistence.bytesUsed}/${session.persistence.bytesLimit}`,
        `- Inventory freshness: ${session.freshness}`,
        `- Known paths: ${session.knownPaths.join(", ") || "none"}`,
        `- Resolved symbols: ${session.resolvedSymbols.join(", ") || "none"}`,
        `- Unresolved symbols: ${session.unresolvedSymbols.join(", ") || "none"}`,
      );
      if (session.bindings.length > 0) {
        lines.push("", "Freshness and revision bindings:");
        for (const binding of session.bindings) {
          lines.push(`- ${binding.provider.name}/${binding.provider.instanceId} workspace ${binding.workspaceId}; index ${binding.indexRevision ?? "unknown"}; repositories ${binding.repositories.map((item) => `${item.repositoryId}@${item.headCommit}:${item.dirtyFingerprint}`).join(", ")}`);
        }
      }
      if (session.inventory.length > 0) {
        lines.push("", "Compact evidence inventory:");
        for (const item of session.inventory) lines.push(`- [${item.freshness}] ${item.provider}:${item.repositoryId}:${item.path}${item.symbol === undefined ? "" : ` (${item.symbol})`}`);
      }
      if (session.decisions.length > 0) {
        lines.push("", "Provider-call and reuse decisions:");
        for (const item of session.decisions) lines.push(`- ${item.operation}/${item.decision.kind}: ${item.decision.reason}`);
      }
      if (session.diagnostics.length > 0) {
        lines.push("", "Retrieval diagnostics:");
        for (const item of session.diagnostics) lines.push(`- ${item.code}: ${item.message}`);
      }
    }

    if (state.retrievalQueries.length > 0) {
      lines.push("", "## Repository retrieval plan");
      for (const query of state.retrievalQueries) {
        lines.push(
          `- ${query.purpose} [${query.focus}]: ${query.text}`
          + (query.literalHints.length === 0 ? "" : `; hints: ${query.literalHints.join(", ")}`)
          + `; results: ${query.resultCount}`
          + (query.degraded ? "; degraded" : ""),
        );
      }
    }
    if (state.codeEvidence.length > 0) {
      lines.push("", "## Code evidence");
      for (const item of state.codeEvidence) {
        lines.push(
          `- [${item.provider}/${item.queryPurpose}/${item.retrievalMethods.join("+")}] ${item.repositoryId}:${item.path}`
          + (item.startLine === undefined ? "" : `:${item.startLine}`)
          + (item.symbol === undefined ? "" : ` (${item.symbol})`)
          + (item.indexState === "ready" ? "" : ` [${item.indexState}]`)
          + (item.degraded ? " [degraded]" : "")
          + `: ${item.preview ?? ""}`,
        );
      }
    }
    if (state.validationEvidence.length > 0) {
      lines.push("", "## Validation evidence");
      for (const item of state.validationEvidence) lines.push(`- ${item.name}: ${item.status} (${item.durationMs} ms)`);
    }
    if (state.manualEdits.length > 0) {
      lines.push("", "## Manual Edits");
      for (const event of state.manualEdits) lines.push(`- ${event.occurredAt}: ${manualEditText(event)}`);
    }
    if (state.corrections.length > 0) {
      lines.push("", "## User corrections");
      for (const event of state.corrections) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
    }
    if (state.findings.length > 0) {
      lines.push("", "## Findings and decisions");
      for (const event of state.findings) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
    }
    if (state.retrievalExplanation.length > 0) {
      lines.push("", "## Retrieval explanation");
      for (const explanation of state.retrievalExplanation) lines.push(`- ${explanation}`);
    }
    if (state.omissions.length > 0) {
      lines.push("", "## Omissions");
      for (const omission of state.omissions) lines.push(`- ${omission}`);
    }
    return `${lines.join("\n")}\n`;
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

  private activePermissions(grants: PermissionGrant[]): PermissionGrant[] {
    const now = Date.now();
    return grants.filter((grant) => grant.revokedAt === undefined && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now));
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
  if (binding.repositories.length !== workspace.repositories.length) return false;
  return binding.repositories.every((repository) => {
    const current = workspace.repositories.find((item) => item.id === repository.repositoryId)?.snapshot;
    return current !== undefined
      && repository.snapshotRepositoryId === current.repositoryId
      && repository.workspaceId === current.workspaceId
      && repository.vcs === current.vcs
      && repository.headCommit === current.headCommit
      && repository.changeId === current.changeId
      && repository.operationId === current.operationId
      && repository.dirtyGeneration === current.dirtyGeneration
      && repository.dirtyFingerprint === current.dirtyFingerprint
      && repository.indexSchemaVersion === current.indexSchemaVersion;
  });
}

function providerFocus(focus: WorkingState["retrievalQueries"][number]["focus"]): CodeSearchFocus {
  return focus === "mixed" ? "auto" : focus;
}

function evidenceKey(hit: CodeSearchHit): string {
  return `${hit.repositoryId}:${hit.path}:${hit.startLine ?? ""}:${hit.endLine ?? ""}:${hit.symbol ?? ""}`;
}

function eventText(event: LedgerEvent): string {
  if (typeof event.payload === "string") return event.payload;
  if (typeof event.payload === "object" && event.payload !== null) {
    const record = event.payload as Record<string, unknown>;
    for (const key of ["message", "text", "summary", "reason"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(event.payload);
}

function manualEditText(event: LedgerEvent): string {
  if (typeof event.payload !== "object" || event.payload === null) return eventText(event);
  const record = event.payload as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : "unknown path";
  const changed = typeof record.changed === "boolean" ? record.changed : undefined;
  return `${path}${changed === undefined ? "" : changed ? " changed" : " reviewed without textual change"}`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
