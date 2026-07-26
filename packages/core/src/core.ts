import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadConfig, type AtelierConfig } from "./config/config.ts";
import { WorkingStateBuilder } from "./state/working-state-builder.ts";
import type {
  ActionRequest,
  ManualEdit,
  ManualEditEditor,
  WorkingState,
  Permission,
  PermissionGrant,
  PolicyDecision,
  TaskProviderStatus,
  TaskReconciliation,
  WorkflowMode,
} from "./domain/types.ts";
import { SqliteLedger } from "./ledger/sqlite-ledger.ts";
import { ensurePlanDocument } from "./planning/plan-document.ts";
import { parsePlanFile } from "./planning/plan-parser.ts";
import {
  PlanReviewService,
  type CancelPlanReviewOptions,
  type CompletePlanReviewOptions,
} from "./planning/plan-review-service.ts";
import { PlanReconciler } from "./planning/plan-reconciler.ts";
import { PolicyEngine } from "./policy/policy-engine.ts";
import { createRepositoryProvider } from "./repository/repository-factory.ts";
import type { RepositoryProvider } from "./repository/repository-provider.ts";
import { ValidationService } from "./validation/validation-service.ts";
import type { CodeProvider } from "./code/provider.ts";
import { DisabledCodeProvider } from "./code/disabled-provider.ts";
import { MockCodeProvider } from "./code/mock-provider.ts";
import { CodesearchProvider } from "./code/codesearch-provider.ts";
import { OctocodeProvider } from "./code/octocode-provider.ts";
import { CodeProviderRegistry } from "./code/registry.ts";
import { CodeService } from "./code/service.ts";
import type { CodeWorkspace } from "./code/types.ts";
import { loadCodeWorkspace, validateCodeWorkspace } from "./code/workspace.ts";
import { BeadsCliTaskProvider } from "./tasks/beads-cli-provider.ts";
import { InMemoryTaskProvider } from "./tasks/in-memory-task-provider.ts";
import { NoopTaskProvider } from "./tasks/noop-task-provider.ts";
import type { TaskProvider } from "./tasks/task-provider.ts";
import { hashFile } from "./util/hash.ts";
import { newId, nowIso } from "./util/ids.ts";

export interface AtelierStatus {
  repositoryRoot: string;
  mode: WorkflowMode;
  planPath: string;
  planExists: boolean;
  approvedPlanHash?: string;
  currentPlanHash?: string;
  planObjective?: string;
  currentTaskId?: string;
  taskProvider: TaskProviderStatus;
  snapshot: ReturnType<RepositoryProvider["snapshot"]>;
  activePermissions: PermissionGrant[];
}

export class AtelierCore {
  readonly config: AtelierConfig;
  readonly ledger: SqliteLedger;
  readonly taskProvider: TaskProvider;
  readonly policy = new PolicyEngine();
  readonly repository: RepositoryProvider;
  readonly planReview: PlanReviewService;
  readonly workingStateBuilder: WorkingStateBuilder;
  readonly validation: ValidationService;
  readonly code: CodeService;

  private constructor(config: AtelierConfig, ledger: SqliteLedger, taskProvider: TaskProvider, codeProvider?: CodeProvider) {
    this.config = config;
    this.ledger = ledger;
    this.taskProvider = taskProvider;
    this.repository = createRepositoryProvider(config, ledger);
    this.planReview = new PlanReviewService({
      repositoryRoot: config.repositoryRoot,
      planPath: config.planPath,
      stateDirectory: config.stateDirectory,
      ledger,
      repository: this.repository,
    });
    this.validation = new ValidationService({ root: config.repositoryRoot, database: ledger.database });
    const selection = codeProvider === undefined ? createCodeProviders(config) : { providers: [codeProvider], defaultProvider: codeProvider.name };
    this.code = new CodeService(new CodeProviderRegistry(selection.providers, selection.defaultProvider), ledger, { maxResults: config.codeMaxResults, maxPreviewBytes: config.codeMaxPreviewBytes, maxChunkBytes: config.codeMaxChunkBytes, maxFetches: config.codeMaxFetches, maxTotalBytes: config.codeMaxTotalBytes });
    this.workingStateBuilder = new WorkingStateBuilder(taskProvider, ledger, this.code, this.validation);
  }

  static open(repositoryRoot = process.cwd(), options: { taskProvider?: "beads" | "memory" | "none"; codeProvider?: CodeProvider } = {}): AtelierCore {
    const config = loadConfig(repositoryRoot);
    if (options.taskProvider !== undefined) config.taskProvider = options.taskProvider;
    mkdirSync(config.stateDirectory, { recursive: true });
    const ledger = new SqliteLedger(config.databasePath);
    const taskProvider: TaskProvider =
      config.taskProvider === "beads"
        ? new BeadsCliTaskProvider({ cwd: config.repositoryRoot, executable: config.beadsCommand })
        : config.taskProvider === "memory"
          ? new InMemoryTaskProvider()
          : new NoopTaskProvider();
    return new AtelierCore(config, ledger, taskProvider, options.codeProvider);
  }

  initialize(options: { createPlan?: boolean } = {}): { createdPlan: boolean } {
    mkdirSync(this.config.stateDirectory, { recursive: true });
    const configPath = resolve(this.config.stateDirectory, "config.json");
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            planPath: relative(this.config.repositoryRoot, this.config.planPath),
            databasePath: relative(this.config.repositoryRoot, this.config.databasePath),
            taskProvider: this.config.taskProvider,
            repositoryProvider: this.config.repositoryProvider,
            jjCommand: this.config.jjCommand,
            codeProvider: this.config.codeProvider,
            codeCommand: this.config.codeCommand,
            octocodeCommand: this.config.octocodeCommand,
            codeMode: this.config.codeMode,
            codeTimeoutMs: this.config.codeTimeoutMs,
            codeIndexTimeoutMs: this.config.codeIndexTimeoutMs,
            codeMaxResults: this.config.codeMaxResults,
            codeMaxPreviewBytes: this.config.codeMaxPreviewBytes,
            codeMaxChunkBytes: this.config.codeMaxChunkBytes,
            codeMaxFetches: this.config.codeMaxFetches,
            codeMaxTotalBytes: this.config.codeMaxTotalBytes,
            longRunningThresholdMs: this.config.longRunningThresholdMs,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    const createdPlan = options.createPlan === false ? false : ensurePlanDocument(this.config.planPath);
    const validationPath = resolve(this.config.stateDirectory, "validation.json");
    if (!existsSync(validationPath)) {
      writeFileSync(validationPath, `${JSON.stringify({ validations: { check: { command: ["aubr", "check"], description: "Run the repository check suite", approval: "always" } } }, null, 2)}\n`, "utf8");
    }
    this.ledger.append({
      kind: "atelier.initialized",
      actor: "user",
      payload: { repositoryRoot: this.config.repositoryRoot, createdPlan },
    });
    return { createdPlan };
  }

  mode(): WorkflowMode {
    return this.ledger.getState<WorkflowMode>("workflowMode") ?? "investigate";
  }

  setMode(mode: WorkflowMode, actor: "user" | "system" = "user"): void {
    const previous = this.mode();
    this.ledger.setState("workflowMode", mode);
    this.ledger.append({ kind: "workflow.mode_changed", actor, payload: { previous, mode } });
  }

  beginPlan(objective: string, options: { actor?: "user" | "system"; metadata?: Record<string, unknown> } = {}): string {
    ensurePlanDocument(this.config.planPath);
    const normalized = objective.replace(/\s+/g, " ").trim();
    this.setMode("plan", options.actor ?? "user");
    this.ledger.setState("planObjective", normalized);
    const run = this.planReview.startWorkflow(normalized, options);
    this.ledger.append({
      kind: "plan.requested",
      actor: options.actor ?? "user",
      repositorySnapshot: this.repository.snapshot(),
      payload: {
        ...(options.metadata ?? {}),
        workflowRunId: run.id,
        objective: normalized,
        path: this.config.planPath,
      },
    });
    return normalized;
  }

  evaluate(request: ActionRequest): PolicyDecision {
    const decision = this.policy.evaluate(request, {
      mode: this.mode(),
      repositoryRoot: this.config.repositoryRoot,
      planPath: this.config.planPath,
      grants: this.ledger.listGrants(),
    });
    this.ledger.append({
      kind: "policy.decision",
      actor: request.actor,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: decision,
    });
    return decision;
  }

  grant(options: {
    permission: Permission;
    scope?: PermissionGrant["scope"];
    actor?: PermissionGrant["actor"];
    taskId?: string;
    paths?: string[];
    reason: string;
    expiresAt?: string;
  }): PermissionGrant {
    const grant: PermissionGrant = {
      id: newId("grant"),
      permission: options.permission,
      scope: options.scope ?? "session",
      actor: options.actor ?? "user",
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      repositoryId: this.repository.snapshot().repositoryId,
      ...(options.paths === undefined ? {} : { paths: options.paths.map((path) => resolve(this.config.repositoryRoot, path)) }),
      reason: options.reason,
      createdAt: nowIso(),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    };
    this.ledger.saveGrant(grant);
    this.ledger.append({ kind: "permission.granted", actor: "user", payload: grant });
    return grant;
  }

  revoke(grantId: string): boolean {
    const revoked = this.ledger.revokeGrant(grantId);
    if (revoked) this.ledger.append({ kind: "permission.revoked", actor: "user", payload: { grantId } });
    return revoked;
  }

  parsePlan() {
    ensurePlanDocument(this.config.planPath);
    return parsePlanFile(this.config.planPath);
  }

  currentWorkflowRun() {
    return this.planReview.currentWorkflowRun();
  }

  beginPlanReview(options: { editor?: ManualEditEditor } = {}): ManualEdit {
    return this.planReview.begin(options);
  }

  completePlanReview(id: string, options: CompletePlanReviewOptions = {}): ManualEdit {
    return this.planReview.complete(id, options);
  }

  cancelPlanReview(id: string, options: CancelPlanReviewOptions): ManualEdit {
    return this.planReview.cancel(id, options);
  }

  approvePlan(): string {
    const plan = this.parsePlan();
    const errors = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length > 0) {
      throw new Error(`Plan cannot be approved: ${errors.map((error) => error.message).join("; ")}`);
    }
    const reviewedPlanHash = this.ledger.getState<string>("reviewedPlanHash");
    if (reviewedPlanHash !== plan.hash) {
      throw new Error("Plan cannot be approved until the current revision has been reviewed in the configured editor.");
    }
    this.ledger.setState("approvedPlanHash", plan.hash);
    this.ledger.append({
      kind: "plan.approved",
      actor: "user",
      repositorySnapshot: this.repository.snapshot(),
      payload: { path: this.config.planPath, hash: plan.hash, taskCount: plan.tasks.length },
    });
    return plan.hash;
  }

  async reconcilePlan(apply = false): Promise<TaskReconciliation> {
    const plan = this.parsePlan();
    const reconciler = new PlanReconciler(this.taskProvider, this.ledger);
    const preview = await reconciler.preview(plan);
    if (!apply) return preview;
    const approvedHash = this.ledger.getState<string>("approvedPlanHash");
    if (approvedHash !== plan.hash) {
      return {
        ...preview,
        conflicts: [...preview.conflicts, "The current plan revision has not been approved."],
      };
    }
    return reconciler.apply(plan, preview);
  }

  codeWorkspace(): CodeWorkspace {
    const snapshot = this.repository.snapshot();
    return loadCodeWorkspace(this.config.repositoryRoot, snapshot);
  }

  validateConfiguration(): string[] {
    const issues = validateCodeWorkspace(this.codeWorkspace());
    if (this.config.codeTimeoutMs < 1) issues.push("codeTimeoutMs must be positive");
    if (this.config.codeIndexTimeoutMs < 1) issues.push("codeIndexTimeoutMs must be positive");
    if (this.config.codeMaxResults < 1) issues.push("codeMaxResults must be positive");
    if (this.config.codeMaxTotalBytes < this.config.codeMaxChunkBytes) issues.push("codeMaxTotalBytes must be >= codeMaxChunkBytes");
    return issues;
  }

  async buildWorkingState(explicitTaskId?: string): Promise<WorkingState> {
    const plan = existsSync(this.config.planPath) ? this.parsePlan() : undefined;
    const snapshot = this.repository.snapshot();
    const state = await this.workingStateBuilder.build({
      mode: this.mode(),
      snapshot,
      workspace: this.codeWorkspace(),
      ...(plan === undefined ? {} : { plan }),
      ...(explicitTaskId === undefined ? {} : { explicitTaskId }),
    });
    this.ledger.append({
      kind: "working_state.built",
      actor: "system",
      ...(state.activeTask === undefined ? {} : { taskId: state.activeTask.id }),
      repositorySnapshot: state.snapshot,
      payload: {
        stateId: state.stateId,
        ...(state.activeTask === undefined ? {} : { activeTaskId: state.activeTask.id }),
        readyTaskCount: state.readyTasks.length,
        taskSelection: state.taskSelection,
        retrievalQueries: state.retrievalQueries.map((query) => ({
          purpose: query.purpose,
          focus: query.focus,
          resultCount: query.resultCount,
          degraded: query.degraded,
        })),
        codeEvidenceCount: state.codeEvidence.length,
        omissions: state.omissions,
      },
    });
    return state;
  }

  async status(): Promise<AtelierStatus> {
    const planExists = existsSync(this.config.planPath);
    const approvedPlanHash = this.ledger.getState<string>("approvedPlanHash");
    const planObjective = this.ledger.getState<string>("planObjective");
    const currentTaskId = this.ledger.getState<string>("currentTaskId");
    let taskProvider: TaskProviderStatus;
    try {
      taskProvider = await this.taskProvider.status();
    } catch (error) {
      taskProvider = {
        provider: this.taskProvider.name,
        available: false,
        initialized: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      repositoryRoot: this.config.repositoryRoot,
      mode: this.mode(),
      planPath: this.config.planPath,
      planExists,
      ...(approvedPlanHash === undefined ? {} : { approvedPlanHash }),
      ...(planExists ? { currentPlanHash: hashFile(this.config.planPath) } : {}),
      ...(planObjective === undefined || planObjective === "" ? {} : { planObjective }),
      ...(currentTaskId === undefined ? {} : { currentTaskId }),
      taskProvider,
      snapshot: this.repository.snapshot(),
      activePermissions: this.ledger.listGrants(),
    };
  }

  close(): void {
    void this.code.close();
    this.ledger.close();
  }
}

function createCodeProviders(config: AtelierConfig): { providers: CodeProvider[]; defaultProvider: string } {
  if (config.codeProvider === "mock") {
    const provider = new MockCodeProvider();
    return { providers: [provider], defaultProvider: provider.name };
  }
  if (config.codeProvider === "disabled") {
    const provider = new DisabledCodeProvider();
    return { providers: [provider], defaultProvider: provider.name };
  }

  const codesearch = new CodesearchProvider({
    command: config.codeCommand,
    cwd: config.repositoryRoot,
    mode: config.codeMode,
    timeoutMs: config.codeTimeoutMs,
    indexTimeoutMs: config.codeIndexTimeoutMs,
  });
  const octocode = new OctocodeProvider({
    command: config.octocodeCommand,
    cwd: config.repositoryRoot,
    timeoutMs: config.codeTimeoutMs,
    environment: { OCTOCODE_CONFIG_PATH: config.octocodeConfigPath },
  });
  return {
    providers: [codesearch, octocode],
    defaultProvider: config.codeProvider,
  };
}
