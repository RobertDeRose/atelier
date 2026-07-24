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
import type { CodeSearchFocus, CodeSearchHit, CodeWorkspace } from "../code/types.ts";
import { RepositoryStatePlanner } from "./repository-state-planner.ts";
import { newId, nowIso } from "../util/ids.ts";

export interface WorkingStateBuildRequest {
  mode: WorkflowMode;
  snapshot: RepositorySnapshot;
  workspace?: CodeWorkspace;
  plan?: ParsedPlan;
  explicitTaskId?: string;
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

    const repositoryPlan = this.repositoryStatePlanner.plan({
      mode: request.mode,
      ...(planObjective === undefined ? {} : { planObjective }),
      ...(activeTask === undefined ? {} : { activeTask }),
      ...(planTask === undefined ? {} : { planTask }),
      ...(request.plan === undefined ? {} : { plan: request.plan }),
    });
    retrievalExplanation.push(...repositoryPlan.explanation);

    const retrievalQueries: WorkingState["retrievalQueries"] = [];
    const codeEvidence: WorkingState["codeEvidence"] = [];
    const seenEvidence = new Set<string>();
    const maximumCodeEvidence = request.maximumCodeEvidence ?? 8;
    if (repositoryPlan.queries.length > 0 && this.code !== undefined && request.workspace !== undefined) {
      for (const query of repositoryPlan.queries) {
        try {
          const results = await this.code.search({
            workspace: request.workspace,
            text: query.text,
            focus: providerFocus(query.focus),
            ...(query.literalHints.length === 0 ? {} : { literalHints: query.literalHints }),
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

    const validationEvidence = this.validation?.latestCurrent(request.snapshot).map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      durationMs: item.durationMs,
    })) ?? [];

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
      permissions,
      corrections,
      findings,
      manualEdits,
      recentEvents,
      retrievalQueries,
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
