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
import type { CodeWorkspace } from "../code/types.ts";
import { newId, nowIso } from "../util/ids.ts";

export interface WorkingStateBuildRequest {
  mode: WorkflowMode;
  snapshot: RepositorySnapshot;
  workspace?: CodeWorkspace;
  plan?: ParsedPlan;
  explicitTaskId?: string;
  maximumReadyTasks?: number;
  maximumRecentEvents?: number;
}

interface TaskSelection {
  task?: TaskRecord;
  explanation?: string;
  omission?: string;
}

export class WorkingStateBuilder {
  private readonly provider: TaskProvider;
  private readonly ledger: SqliteLedger;
  private readonly code: CodeService | undefined;
  private readonly validation: ValidationService | undefined;

  constructor(provider: TaskProvider, ledger: SqliteLedger, code?: CodeService, validation?: ValidationService) {
    this.provider = provider;
    this.ledger = ledger;
    this.code = code;
    this.validation = validation;
  }

  async build(request: WorkingStateBuildRequest): Promise<WorkingState> {
    const omissions: string[] = [];
    const retrievalExplanation: string[] = [];
    const readyTasks = await this.readyTasks(request.maximumReadyTasks ?? 10, omissions);
    const selection = await this.selectTask(request.explicitTaskId, readyTasks);
    if (selection.omission !== undefined) omissions.push(selection.omission);
    if (selection.explanation !== undefined) retrievalExplanation.push(selection.explanation);

    const activeTask = selection.task;
    const planTask = this.findPlanTask(request.plan, activeTask);
    const permissions = this.activePermissions(this.ledger.listGrants());
    const recentEvents = this.ledger.listEvents({ limit: request.maximumRecentEvents ?? 30 });
    const corrections = recentEvents.filter((event) => event.kind === "correction");
    const findings = recentEvents.filter((event) => event.kind === "finding" || event.kind === "decision");
    const approvedPlanHash = this.ledger.getState<string>("approvedPlanHash");
    const query = [activeTask?.title, planTask?.goal, ...(planTask?.scope ?? [])]
      .filter((value): value is string => Boolean(value))
      .join(" ");

    let codeEvidence: WorkingState["codeEvidence"] = [];
    if (query && this.code !== undefined && request.workspace !== undefined) {
      try {
        const results = await this.code.search({ workspace: request.workspace, text: query, limit: 8 });
        codeEvidence = results.map((hit) => ({
          provider: hit.provenance.provider.name,
          repositoryId: hit.repositoryId,
          path: hit.path,
          ...(hit.language === undefined ? {} : { language: hit.language }),
          ...(hit.symbol === undefined ? {} : { symbol: hit.symbol }),
          ...(hit.startLine === undefined ? {} : { startLine: hit.startLine }),
          ...(hit.preview === undefined ? {} : { preview: hit.preview }),
          indexState: hit.provenance.indexState,
        }));
      } catch (error) {
        omissions.push(`Code provider unavailable: ${errorMessage(error)}`);
      }
    }

    const validationEvidence = this.validation?.latestCurrent(request.snapshot).map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      durationMs: item.durationMs,
    })) ?? [];

    if (activeTask !== undefined) this.ledger.setState("currentTaskId", activeTask.id);
    if (request.plan === undefined) {
      omissions.push("No plan document was supplied to the working state builder.");
    } else if (planTask === undefined && activeTask !== undefined) {
      omissions.push("The active provider task could not be mapped to a plan task.");
    } else if (planTask !== undefined) {
      retrievalExplanation.push(`Included reviewed-plan task ${planTask.id}.`);
    }
    retrievalExplanation.push(`Included ${permissions.length} active permission grant(s).`);
    retrievalExplanation.push(`Included ${corrections.length} correction(s) and ${findings.length} finding/decision record(s).`);
    retrievalExplanation.push(`Included ${codeEvidence.length} normalized code result(s) and ${validationEvidence.length} current validation record(s).`);

    return {
      stateId: newId("state"),
      generatedAt: nowIso(),
      snapshot: request.snapshot,
      mode: request.mode,
      ...(activeTask === undefined ? {} : { activeTask }),
      readyTasks,
      ...(approvedPlanHash === undefined ? {} : { approvedPlanHash }),
      ...(planTask === undefined ? {} : { planTask }),
      permissions,
      corrections,
      findings,
      recentEvents,
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
    ];

    if (state.approvedPlanHash) lines.push(`- Approved plan: ${state.approvedPlanHash}`);
    if (state.activeTask) {
      lines.push("", "## Current task", "", `**${state.activeTask.id}: ${state.activeTask.title}**`, "");
      if (state.activeTask.description) lines.push(state.activeTask.description, "");
      if (state.activeTask.dependencies.length > 0) lines.push(`Dependencies: ${state.activeTask.dependencies.join(", ")}`, "");
      if (state.activeTask.acceptanceCriteria.length > 0) {
        lines.push("Completion and validation:");
        for (const criterion of state.activeTask.acceptanceCriteria) lines.push(`- ${criterion}`);
      }
    } else {
      lines.push("", "## Current task", "", "No task is currently selected.");
    }

    if (state.planTask) {
      lines.push("", "## Reviewed plan scope", "", `Plan task: ${state.planTask.id} — ${state.planTask.title}`);
      if (state.planTask.scope.length > 0) lines.push("", "In scope:", ...state.planTask.scope.map((item) => `- ${item}`));
      if (state.planTask.outOfScope.length > 0) lines.push("", "Out of scope:", ...state.planTask.outOfScope.map((item) => `- ${item}`));
    }

    lines.push("", "## Active permissions");
    if (state.permissions.length === 0) lines.push("", "No mutation permissions are active.");
    for (const grant of state.permissions) lines.push(`- ${grant.permission} (${grant.scope}): ${grant.reason}`);

    if (state.codeEvidence.length > 0) {
      lines.push("", "## Code evidence");
      for (const item of state.codeEvidence) {
        lines.push(`- [${item.provider}] ${item.repositoryId}:${item.path}${item.startLine === undefined ? "" : `:${item.startLine}`}${item.symbol === undefined ? "" : ` (${item.symbol})`}${item.indexState === "ready" ? "" : ` [${item.indexState}]`}: ${item.preview ?? ""}`);
      }
    }
    if (state.validationEvidence.length > 0) {
      lines.push("", "## Validation evidence");
      for (const item of state.validationEvidence) lines.push(`- ${item.name}: ${item.status} (${item.durationMs} ms)`);
    }
    if (state.corrections.length > 0) {
      lines.push("", "## User corrections");
      for (const event of state.corrections) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
    }
    if (state.findings.length > 0) {
      lines.push("", "## Findings and decisions");
      for (const event of state.findings) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
    }
    if (state.omissions.length > 0) {
      lines.push("", "## Omissions");
      for (const omission of state.omissions) lines.push(`- ${omission}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private async readyTasks(limit: number, omissions: string[]): Promise<TaskRecord[]> {
    try { return (await this.provider.ready()).slice(0, limit); }
    catch (error) { omissions.push(`Task provider ${this.provider.name} is unavailable: ${errorMessage(error)}`); return []; }
  }

  private async selectTask(explicitTaskId: string | undefined, readyTasks: TaskRecord[]): Promise<TaskSelection> {
    if (explicitTaskId !== undefined) {
      try {
        const task = await this.provider.get(explicitTaskId);
        return task === undefined ? { omission: `Explicit task ${explicitTaskId} was not found.` } : { task, explanation: `Selected explicitly requested task ${task.id}.` };
      } catch (error) { return { omission: `Unable to read explicit task ${explicitTaskId}: ${errorMessage(error)}` }; }
    }
    const currentTaskId = this.ledger.getState<string>("currentTaskId");
    if (currentTaskId !== undefined) {
      try {
        const current = await this.provider.get(currentTaskId);
        if (current !== undefined && current.status !== "closed" && current.status !== "deferred") return { task: current, explanation: `Resumed current task ${current.id} from durable task state.` };
      } catch {}
    }
    const ready = readyTasks[0];
    return ready === undefined ? { omission: "No active or ready task was available from the configured task provider." } : { task: ready, explanation: `Selected ready task ${ready.id} from durable task state.` };
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
}

function eventText(event: LedgerEvent): string {
  if (typeof event.payload === "string") return event.payload;
  if (typeof event.payload === "object" && event.payload !== null) {
    const record = event.payload as Record<string, unknown>;
    for (const key of ["message", "text", "summary", "reason"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(event.payload);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
