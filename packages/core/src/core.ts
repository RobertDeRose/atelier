import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type AtelierConfig } from "./config/config.ts";
import { WorkingStateBuilder } from "./state/working-state-builder.ts";
import type {
  ApprovedTaskConstraint,
  WorkflowActionRequest,
  ExecutionEvidence,
  ExecutionGrant,
  FinalDiffPreview,
  FinalDiffReview,
  ManualEdit,
  ManualEditEditor,
  WorkingState,
  WorkflowDecision,
  TaskClosureReadiness,
  TaskProviderStatus,
  TaskReconciliation,
  TaskRecord,
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
import { WorkflowGuard } from "./workflow/workflow-guard.ts";
import { ExecutionWorkflowCoordinator } from "./workflow/execution-workflow-coordinator.ts";
import { constraintsForPlanTask, sourceBaselineMismatch } from "./workflow/execution-baseline.ts";
import { createRepositoryProvider } from "./repository/repository-factory.ts";
import type {
  RepositoryObservation,
  RepositoryObserveOptions,
  RepositoryProvider,
} from "./repository/repository-provider.ts";
import {
  WorkspaceRepositoryService,
  type WorkspaceCommitResult,
} from "./repository/workspace-repository-service.ts";
import { sourceRevisionIdentity, sourceSnapshotFingerprint } from "./repository/snapshot.ts";
import { ValidationService } from "./validation/validation-service.ts";
import type { CodeProvider } from "./code/provider.ts";
import { DisabledCodeProvider } from "./code/disabled-provider.ts";
import { MockCodeProvider } from "./code/mock-provider.ts";
import { CodesearchProvider } from "./code/codesearch-provider.ts";
import { OctocodeProvider } from "./code/octocode-provider.ts";
import { CodeProviderRegistry } from "./code/registry.ts";
import { CodeService } from "./code/service.ts";
import type { CodeWorkspace } from "./code/types.ts";
import { loadCodeWorkspace, loadCodeWorkspaceAsync, validateCodeWorkspace } from "./code/workspace.ts";
import { BeadsCliTaskProvider } from "./tasks/beads-cli-provider.ts";
import { InMemoryTaskProvider } from "./tasks/in-memory-task-provider.ts";
import { NoopTaskProvider } from "./tasks/noop-task-provider.ts";
import type { TaskProvider } from "./tasks/task-provider.ts";
import type { RepositoryDisplayState } from "./repository/repository-provider.ts";
import { hashFile, sha256 } from "./util/hash.ts";
import { newId, nowIso } from "./util/ids.ts";
import { isPathWithin, resolveAccessPath } from "./security/path-boundary.ts";
import { isSourcePath, sourcePaths } from "./repository/source-path.ts";
import { repositoryPathTarget, repositoryPathTargets, repositoryRelativePath } from "./repository/repository-path.ts";
import {
  repositoryRevisionBinding,
  type RepositoryRevisionBinding,
} from "./repository/revision-binding.ts";
import { WorkspacePolicyEvaluator, type FilesystemEffect, type WorkspacePolicyDecision } from "./policy/workspace-policy.ts";
import { RecoveryManager, type RecoveryCheckpoint } from "./recovery/recovery-manager.ts";
import { PerformanceRecorder } from "./performance/performance-recorder.ts";

export interface AtelierStatus {
  repositoryRoot: string;
  workspaceRoot: string;
  workspaceSource: "startup_cwd" | "explicit";
  runtimeDirectory: string;
  mode: WorkflowMode;
  planPath: string;
  planExists: boolean;
  planStatus: "missing" | "not_approved" | "approved";
  approvedPlanHash?: string;
  currentPlanHash?: string;
  planObjective?: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
  activeExecutionGrant?: ExecutionGrant;
  taskProvider: TaskProviderStatus;
  snapshot: ReturnType<RepositoryProvider["snapshot"]>;
  repositoryDisplay: RepositoryDisplayState;
  /** Revision identity used by the footer without rebuilding a code workspace. */
  workspaceSourceDigest: string;
  activeTaskConstraints: ApprovedTaskConstraint[];
  workflowCheckpoint: string;
  closureStatus: string;
  nextAction: string;
}

function repositoryRelativeSourcePath(repositoryRoot: string, path: string): string | undefined {
  try {
    const rel = repositoryRelativePath(repositoryRoot, path, "write");
    return rel === "." || !isSourcePath(rel) ? undefined : rel;
  } catch {
    return undefined;
  }
}

function sourcePathFingerprint(repositoryRoot: string, path: string): string {
  const entry = repositoryPathTarget(repositoryRoot, path, "read").entry;
  try {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(entry)}`;
    if (!stat.isFile()) return `non-file:${stat.mode}:${stat.size}`;
    return `file:${stat.size}:${sha256(readFileSync(entry))}`;
  } catch {
    return "missing";
  }
}

function pathFingerprintMap(repositoryRoot: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, sourcePathFingerprint(repositoryRoot, path)]));
}

export class AtelierCore {
  readonly config: AtelierConfig;
  readonly ledger: SqliteLedger;
  readonly taskProvider: TaskProvider;
  readonly workflowGuard = new WorkflowGuard();
  readonly repository: RepositoryProvider;
  readonly planReview: PlanReviewService;
  readonly workingStateBuilder: WorkingStateBuilder;
  readonly validation: ValidationService;
  readonly code: CodeService;
  readonly execution: ExecutionWorkflowCoordinator;
  readonly workspacePolicy: WorkspacePolicyEvaluator;
  readonly recovery: RecoveryManager;
  readonly performance = new PerformanceRecorder();
  private readonly workspaceRepositoryProviders = new Map<string, RepositoryProvider>();
  private lastCodeWorkspace?: CodeWorkspace;
  private codeWorkspacePromise?: Promise<CodeWorkspace>;
  private repositoryObservationGeneration = 0;
  private cachedTaskClosure?: { executionGrantId: string; readiness: TaskClosureReadiness };

  private constructor(
    config: AtelierConfig,
    ledger: SqliteLedger,
    taskProvider: TaskProvider,
    codeProvider?: CodeProvider,
    retrievalSessionId?: string,
  ) {
    this.config = config;
    this.ledger = ledger;
    this.taskProvider = taskProvider;
    this.repository = createRepositoryProvider(config, ledger);
    this.workspacePolicy = new WorkspacePolicyEvaluator({ root: config.workspaceRoot, secretPatterns: config.secretPathPatterns });
    this.recovery = new RecoveryManager({ workspaceRoot: config.workspaceRoot, runtimeDirectory: config.runtimeDirectory, maxBytes: config.checkpointMaxBytes, repository: this.repository });
    this.planReview = new PlanReviewService({
      repositoryRoot: config.repositoryRoot,
      planPath: config.planPath,
      stateDirectory: config.runtimeDirectory,
      ledger,
      repository: this.repository,
    });
    this.validation = new ValidationService({
      root: config.repositoryRoot,
      database: ledger.database,
      manifestPath: config.validationPath,
    });
    const effectiveCodeProvider = codeProvider;
    const selection = effectiveCodeProvider === undefined
      ? createCodeProviders(config)
      : { providers: [effectiveCodeProvider], defaultProvider: effectiveCodeProvider.name };
    this.code = new CodeService(
      new CodeProviderRegistry(selection.providers, selection.defaultProvider),
      ledger,
      {
        maxResults: positiveOrOne(config.codeMaxResults),
        maxPreviewBytes: positiveOrOne(config.codeMaxPreviewBytes),
        maxChunkBytes: positiveOrOne(config.codeMaxChunkBytes),
        maxFetches: positiveOrOne(config.codeMaxFetches),
        maxTotalBytes: positiveOrOne(config.codeMaxTotalBytes),
        maxProviderRequests: positiveOrOne(config.codeMaxProviderRequests),
        maxUniquePaths: positiveOrOne(config.codeMaxUniquePaths),
        maxEvidenceEntries: positiveOrOne(config.codeMaxEvidenceEntries),
      },
      retrievalSessionId,
      {
        maxRetainedSessions: positiveOrOne(config.codeRetainedSessions),
        maxEntries: positiveOrOne(config.codeMaxPersistedEntries),
        maxBytes: positiveOrOne(config.codeMaxPersistedBytes),
      },
    );
    this.execution = new ExecutionWorkflowCoordinator({
      planPath: config.planPath,
      ledger,
      provider: taskProvider,
      repository: this.repository,
      repositoryRoot: config.repositoryRoot,
      sourceContext: async () => {
        const workspace = await this.observeCodeWorkspace({ force: true, operation: "execution-source" });
        const primary = workspace.repositories.find((repository) => repository.root === this.config.repositoryRoot)
          ?? workspace.repositories[0];
        if (primary === undefined) throw new Error("Execution source context has no workspace repository.");
        return {
          repositorySnapshot: primary.snapshot,
          repositoryBindings: workspace.repositories.map((repository) =>
            repositoryRevisionBinding(repository.id, repository.snapshot)),
          retrievalBindings: this.code.retrievalStatus().bindings,
          repositoryRoots: Object.fromEntries(workspace.repositories.map((repository) => [repository.id, repository.root])),
          primaryRepositoryId: primary.id,
        };
      },
      validationConstraints: () => Object.entries(this.validation.manifest().validations)
        .map(([name, definition]) => ({
          name,
          category: definition.category === "full" ? "full" as const : "focused" as const,
          required: definition.required === true,
        })),
      validationRequired: () => this.validation.closurePolicy().requireValidation,
    });
    this.workingStateBuilder = new WorkingStateBuilder(taskProvider, ledger, this.code, this.validation);
  }

  static open(repositoryRoot = process.cwd(), options: {
    taskProvider?: "beads" | "memory" | "none";
    taskProviderInstance?: TaskProvider;
    codeProvider?: CodeProvider;
    retrievalSessionId?: string;
    workspaceRoot?: string;
  } = {}): AtelierCore {
    const config = loadConfig(repositoryRoot, options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot });
    if (options.taskProvider !== undefined) config.taskProvider = options.taskProvider;
    mkdirSync(config.runtimeDirectory, { recursive: true, mode: 0o700 });
    const ledger = new SqliteLedger(config.databasePath);
    const taskProvider: TaskProvider = options.taskProviderInstance ?? (
      config.taskProvider === "beads"
        ? new BeadsCliTaskProvider({ cwd: config.repositoryRoot, executable: config.beadsCommand })
        : config.taskProvider === "memory"
          ? new InMemoryTaskProvider()
          : new NoopTaskProvider()
    );
    return new AtelierCore(config, ledger, taskProvider, options.codeProvider, options.retrievalSessionId);
  }

  async observeRepository(
    options: RepositoryObserveOptions & { operation?: string } = {},
  ): Promise<RepositoryObservation> {
    const operation = options.operation ?? "repository";
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const observation = this.repository.observe !== undefined
      ? await this.repository.observe(options)
      : {
          status: this.repository.status(),
          snapshot: this.repository.snapshot(),
          displayState: this.repository.displayState?.() ?? { vcs: this.repository.name, state: "unknown" as const },
          root: this.config.repositoryRoot,
          rawChangedPaths: this.repository.rawChangedPaths(),
          changedPaths: this.repository.changedPaths(),
          ...(options.includeFiles ? { files: this.repository.listFiles() } : {}),
          pathStates: Object.fromEntries(repositoryPathTargets(this.config.repositoryRoot, options.paths ?? [], "write")
            .flatMap((target) => {
              const state = this.repository.classifyPath?.(target.entry) ?? "unknown";
              return [...new Set([target.key, target.entry])]
                .map((path) => [path, state] as const);
            })),
          observedAt: new Date().toISOString(),
          metrics: { durationMs: 0, subprocesses: 0, filesHashed: 0, bytesHashed: 0, cacheHit: false },
        } satisfies RepositoryObservation;
    this.performance.record({
      operation,
      phase: "repository.observe",
      durationMs: performance.now() - started,
      startedAt,
      subprocesses: observation.metrics.subprocesses,
      filesHashed: observation.metrics.filesHashed,
      bytesHashed: observation.metrics.bytesHashed,
      cache: observation.metrics.cacheHit ? "hit" : "miss",
      detail: { provider: observation.snapshot.vcs, changedPaths: observation.rawChangedPaths.length },
    });
    return observation;
  }

  invalidateRepositoryObservation(): void {
    this.repositoryObservationGeneration += 1;
    this.repository.invalidateObservation?.();
    for (const provider of this.workspaceRepositoryProviders.values()) provider.invalidateObservation?.();
    delete this.lastCodeWorkspace;
    delete this.codeWorkspacePromise;
    delete this.cachedTaskClosure;
  }

  performanceReport(limit = 100) {
    return {
      interactive: this.performance.summary(limit),
      sqlite: this.ledger.performanceSummary(limit),
    };
  }

  clearPerformanceReport(): void {
    this.performance.clear();
    this.ledger.clearPerformanceSamples();
  }

  initialize(options: { createPlan?: boolean } = {}): { createdPlan: boolean } {
    mkdirSync(this.config.projectDirectory, { recursive: true });
    mkdirSync(this.config.runtimeDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.config.projectConfigPath)) {
      writeFileSync(
        this.config.projectConfigPath,
        `${JSON.stringify(
          {
            planPath: repositoryRelativePath(this.config.repositoryRoot, this.config.planPath, "write"),
            taskProvider: this.config.taskProvider,
            repositoryProvider: this.config.repositoryProvider,
            codeProvider: this.config.codeProvider,
            codeMode: this.config.codeMode,
            codeTimeoutMs: this.config.codeTimeoutMs,
            codeIndexTimeoutMs: this.config.codeIndexTimeoutMs,
            codeMaxResults: this.config.codeMaxResults,
            codeMaxPreviewBytes: this.config.codeMaxPreviewBytes,
            codeMaxChunkBytes: this.config.codeMaxChunkBytes,
            codeMaxFetches: this.config.codeMaxFetches,
            codeMaxTotalBytes: this.config.codeMaxTotalBytes,
            codeMaxProviderRequests: this.config.codeMaxProviderRequests,
            codeMaxUniquePaths: this.config.codeMaxUniquePaths,
            codeMaxEvidenceEntries: this.config.codeMaxEvidenceEntries,
            codeRetainedSessions: this.config.codeRetainedSessions,
            codeMaxPersistedEntries: this.config.codeMaxPersistedEntries,
            codeMaxPersistedBytes: this.config.codeMaxPersistedBytes,
            longRunningThresholdMs: this.config.longRunningThresholdMs,
            providerFirstRetrieval: this.config.providerFirstRetrieval,
          },
          null,
          2,
        )}
`,
        "utf8",
      );
    }
    const createdPlan = options.createPlan === false ? false : ensurePlanDocument(this.config.planPath);
    if (!existsSync(this.config.validationPath)) {
      writeFileSync(
        this.config.validationPath,
        `${JSON.stringify({
          closurePolicy: {
            requireValidation: true,
            requireFinalDiffReview: true,
            requireLocalChange: true,
            requireCleanSource: true,
            requireCleanRepository: true,
          },
          validations: {},
        }, null, 2)}
`,
        "utf8",
      );
    }
    this.ledger.append({
      kind: "atelier.initialized",
      actor: "user",
      payload: {
        repositoryRoot: this.config.repositoryRoot,
        runtimeDirectory: this.config.runtimeDirectory,
        workspaceRoot: this.config.workspaceRoot,
        createdPlan,
      },
    });
    return { createdPlan };
  }

  mode(): WorkflowMode {
    return this.ledger.getState<WorkflowMode>("workflowMode") ?? "investigate";
  }

  setMode(mode: WorkflowMode, actor: "user" | "system" = "user"): void {
    if (mode === "act" && this.ledger.getActiveExecutionGrant() === undefined) {
      throw new Error("Act mode requires an active task-scoped execution grant.");
    }
    const previous = this.mode();
    this.ledger.setState("workflowMode", mode);
    this.ledger.append({ kind: "workflow.mode_changed", actor, payload: { previous, mode } });
  }

  beginPlan(objective: string, options: { actor?: "user" | "system"; metadata?: Record<string, unknown> } = {}): string {
    ensurePlanDocument(this.config.planPath);
    if (this.ledger.getActiveExecutionGrant() !== undefined) {
      this.execution.cancel("A new planning workflow invalidated the active execution grant.");
    }
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

  activeTaskConstraints(): ApprovedTaskConstraint[] {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return [];
    const approval = this.ledger.listPlanApprovals().find((candidate) => candidate.id === grant.planApprovalId);
    if (approval === undefined) return [];
    return constraintsForPlanTask(approval.taskConstraints, grant.planTaskId);
  }

  evaluateWorkflow(request: WorkflowActionRequest): WorkflowDecision {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const decision = this.workflowGuard.evaluate(request, {
      mode: this.mode(),
      workspaceRoot: this.config.workspaceRoot,
      planPath: this.config.planPath,
      ...(executionGrant === undefined ? {} : { executionGrant, executionPaused: this.execution.isPaused() }),
      taskConstraints: this.activeTaskConstraints(),
      ...(request.action === "task.close" ? { taskClosure: this.taskClosureReadiness() } : {}),
    });
    this.ledger.append({
      kind: "workflow.authorization_decision",
      actor: request.actor,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: decision,
    });
    return decision;
  }

  beginExecutionEvidence(input: {
    toolCallId: string;
    toolName: string;
    request: WorkflowActionRequest;
    workflowDecisionId: string;
    checkpointId?: string;
    repositoryObservation?: RepositoryObservation;
  }): ExecutionEvidence {
    if (input.request.action === "read.repository") throw new Error("Read-only tools do not create mutation execution evidence.");
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined || input.request.taskId !== executionGrant.taskId) {
      throw new Error("Mutation execution evidence requires the active task execution grant.");
    }
    const decisionEvent = this.ledger.listEvents({ kind: "workflow.authorization_decision", limit: 100 })
      .find((event) => (event.payload as WorkflowDecision).id === input.workflowDecisionId);
    const decision = decisionEvent?.payload as WorkflowDecision | undefined;
    const authorizedSnapshot = decisionEvent?.repositorySnapshot;
    const currentSnapshot = input.repositoryObservation?.snapshot ?? this.repository.snapshot();
    if (decision === undefined || decision.result !== "allow" || decision.action !== input.request.action
      || decisionEvent?.taskId !== executionGrant.taskId
      || authorizedSnapshot === undefined
      || sourceBaselineMismatch(authorizedSnapshot, currentSnapshot) !== undefined) {
      throw new Error("Mutation execution evidence requires a current matching allow policy decision.");
    }
    const evidence: ExecutionEvidence = {
      id: newId("execution-evidence"),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      action: input.request.action,
      status: "started",
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      workflowDecisionId: input.workflowDecisionId,
      ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
      beforeSnapshot: currentSnapshot,
      requestedPaths: sourcePaths((input.request.paths ?? [])
        .flatMap((path) => repositoryRelativeSourcePath(this.config.repositoryRoot, path) ?? [])),
      beforeChangedPaths: input.request.action === "task.close"
        ? (input.repositoryObservation?.rawChangedPaths ?? this.repository.rawChangedPaths())
        : sourcePaths(input.repositoryObservation?.changedPaths ?? this.repository.changedPaths()),
      changedPaths: [],
      newlyChangedPaths: [],
      furtherModifiedPaths: [],
      removedPaths: [],
      unchangedExistingDirtyPaths: [],
      pathFingerprintsBefore: {},
      observedMutation: false,
      startedAt: nowIso(),
    };
    evidence.pathFingerprintsBefore = pathFingerprintMap(
      this.config.repositoryRoot,
      [...new Set([...evidence.beforeChangedPaths, ...evidence.requestedPaths])].sort(),
    );
    this.ledger.saveExecutionEvidence(evidence);
    this.ledger.append({
      kind: "execution.tool_started",
      actor: "agent",
      taskId: evidence.taskId,
      repositorySnapshot: evidence.beforeSnapshot,
      payload: { id: evidence.id, toolCallId: evidence.toolCallId, toolName: evidence.toolName, action: evidence.action },
    });
    return evidence;
  }

  completeExecutionEvidence(toolCallId: string, input: {
    status: "succeeded" | "failed" | "interrupted";
    error?: string;
  }): ExecutionEvidence | undefined {
    const current = this.ledger.getExecutionEvidence(toolCallId);
    if (current === undefined || current.status !== "started") return current;
    const afterSnapshot = this.repository.snapshot();
    const afterChangedPaths = current.action === "task.close"
      ? this.repository.rawChangedPaths()
      : sourcePaths(this.repository.changedPaths());
    const beforeChanged = new Set(current.beforeChangedPaths ?? []);
    const afterChanged = new Set(afterChangedPaths);
    const candidates = [...new Set([
      ...(current.beforeChangedPaths ?? []),
      ...afterChangedPaths,
      ...(current.requestedPaths ?? []),
    ])].sort();
    const afterFingerprints = pathFingerprintMap(this.config.repositoryRoot, candidates);
    const newlyChangedPaths = candidates.filter((path) => !beforeChanged.has(path) && afterChanged.has(path));
    const furtherModifiedPaths = candidates.filter((path) => beforeChanged.has(path)
      && afterChanged.has(path)
      && current.pathFingerprintsBefore?.[path] !== afterFingerprints[path]);
    const removedPaths = (current.beforeChangedPaths ?? []).filter((path) => !afterChanged.has(path));
    const unchangedExistingDirtyPaths = candidates.filter((path) => beforeChanged.has(path)
      && afterChanged.has(path)
      && current.pathFingerprintsBefore?.[path] === afterFingerprints[path]);
    const closureEvent = current.action === "task.close"
      ? this.ledger.listEvents({ kind: "task.closed", taskId: current.taskId, limit: 1 })[0]
      : undefined;
    const closureFinalization = closureEvent?.payload !== undefined && typeof closureEvent.payload === "object"
      ? (closureEvent.payload as {
          finalization?: { providerMutationPaths?: string[]; workflowFinalizationPaths?: string[] };
        }).finalization
      : undefined;
    const providerMutationPaths = [...new Set(closureFinalization?.providerMutationPaths ?? [])].sort();
    const workflowFinalizationPaths = [...new Set(closureFinalization?.workflowFinalizationPaths ?? [])].sort();
    const changedPaths = [...new Set([
      ...newlyChangedPaths,
      ...furtherModifiedPaths,
      ...removedPaths,
      ...providerMutationPaths,
      ...workflowFinalizationPaths,
    ])].sort();
    const observedMutation = changedPaths.length > 0;
    const evidence: ExecutionEvidence = {
      ...current,
      status: input.status,
      afterSnapshot,
      changedPaths,
      newlyChangedPaths,
      furtherModifiedPaths,
      removedPaths,
      unchangedExistingDirtyPaths,
      ...(providerMutationPaths.length === 0 ? {} : { providerMutationPaths }),
      ...(workflowFinalizationPaths.length === 0 ? {} : { workflowFinalizationPaths }),
      pathFingerprintsAfter: afterFingerprints,
      observedMutation,
      ...(input.error === undefined ? {} : { error: input.error.slice(0, 4_096) }),
      finishedAt: nowIso(),
    };
    this.ledger.saveExecutionEvidence(evidence);
    this.ledger.append({
      kind: `execution.tool_${input.status}`,
      actor: "tool",
      taskId: evidence.taskId,
      repositorySnapshot: afterSnapshot,
      payload: {
        id: evidence.id,
        toolCallId,
        action: evidence.action,
        observedMutation,
        changedPaths,
        newlyChangedPaths,
        furtherModifiedPaths,
        removedPaths,
        unchangedExistingDirtyPaths,
        ...(providerMutationPaths.length === 0 ? {} : { providerMutationPaths }),
        ...(workflowFinalizationPaths.length === 0 ? {} : { workflowFinalizationPaths }),
        ...(evidence.error === undefined ? {} : { error: evidence.error }),
      },
    });
    return evidence;
  }

  interruptPendingExecutionEvidence(reason: string): ExecutionEvidence[] {
    return this.ledger.listExecutionEvidence({ limit: 100 })
      .filter((item) => item.status === "started")
      .flatMap((item) => {
        const completed = this.completeExecutionEvidence(item.toolCallId, { status: "interrupted", error: reason });
        return completed === undefined ? [] : [completed];
      });
  }

  selectFocusedValidation(changedSymbols: string[] = []) {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("Focused validation selection requires an active execution grant.");
    const repositories = this.workspaceRepositories(executionGrant);
    const changedPaths = repositories.approvedChanges(true)
      .flatMap((entry) => entry.changedPaths.map((path) => repositories.qualify(entry.repositoryId, path)));
    this.ledger.setWorkflowCheckpoint("validating");
    const selection = this.validation.saveFocusedSelection({
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      planHash: executionGrant.planHash,
      reconciliationDigest: executionGrant.reconciliationDigest,
      snapshot: repositories.evidenceSnapshot(),
      changedPaths,
      changedSymbols,
    });
    this.ledger.append({
      kind: "validation.focused_selected",
      actor: "system",
      taskId: executionGrant.taskId,
      repositorySnapshot: selection.snapshot,
      payload: selection,
    });
    return selection;
  }

  async runValidation(name: string, options: { signal?: AbortSignal; selectionId?: string; maxOutputBytes?: number } = {}) {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const snapshot = this.currentValidationSnapshot();
    if (executionGrant !== undefined) {
      const action = this.validation.action(name);
      const decision = this.evaluateWorkflow({
        action,
        risk: "routine",
        actor: "agent",
        taskId: executionGrant.taskId,
        repositorySnapshot: snapshot,
        validationName: name,
          rationale: `Run configured ${action === "validation.focused" ? "focused" : "full-suite"} validation ${name}.`,
      });
      if (decision.result !== "allow") throw new Error(decision.reason);
    }
    this.ledger.setWorkflowCheckpoint("validating");
    const evidence = await this.validation.run(name, snapshot, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.selectionId === undefined ? {} : { selectionId: options.selectionId }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(executionGrant === undefined ? {} : {
        taskId: executionGrant.taskId,
        executionGrantId: executionGrant.id,
        planHash: executionGrant.planHash,
      }),
    });
    this.ledger.append({
      kind: "validation.completed",
      actor: "tool",
      ...(executionGrant === undefined ? {} : { taskId: executionGrant.taskId }),
      repositorySnapshot: snapshot,
      payload: {
        id: evidence.id,
        name,
        status: evidence.status,
        durationMs: evidence.durationMs,
        ...(options.selectionId === undefined ? {} : { selectionId: options.selectionId }),
      },
    });
    return evidence;
  }

  activeExecutionConstraints(): ApprovedTaskConstraint[] {
    return this.activeTaskConstraints();
  }

  approvedTaskPaths(): string[] {
    return [...new Set(this.activeExecutionConstraints().flatMap((constraint) => constraint.writePaths))].sort();
  }

  approvedValidationNames(category: "focused" | "full"): string[] {
    return [...new Set(this.activeExecutionConstraints().flatMap((constraint) =>
      category === "focused" ? constraint.focusedValidations : constraint.fullValidations))].sort();
  }

  private workspaceRepositories(
    executionGrant = this.ledger.getActiveExecutionGrant(),
    workspace = this.codeWorkspace(),
    useWorkspaceSnapshots = false,
  ): WorkspaceRepositoryService {
    return new WorkspaceRepositoryService({
      workspace,
      primaryRoot: this.config.repositoryRoot,
      primaryProvider: this.repository,
      providerForRoot: (root) => createRepositoryProvider(this.config, this.ledger, root),
      approvedPaths: executionGrant === undefined ? [] : this.approvedTaskPaths(),
      ...(executionGrant?.repositoryBindings === undefined
        ? {}
        : { baselines: executionGrant.repositoryBindings }),
      useWorkspaceSnapshots,
    });
  }

  currentValidationSnapshot(): ReturnType<RepositoryProvider["snapshot"]> {
    return this.workspaceRepositories().evidenceSnapshot();
  }

  currentSourceChangedPaths(): string[] {
    return this.workspaceRepositories().sourceChangedPaths();
  }


  currentFinalDiffReview(): FinalDiffReview | undefined {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) return undefined;
    return this.ledger.getState<FinalDiffReview>(`finalDiffReview:${executionGrant.id}`);
  }

  previewFinalDiff(): FinalDiffPreview {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("Final diff review requires an active execution grant.");
    const repositories = this.workspaceRepositories(executionGrant);
    const preview = repositories.diff(true);
    const baseline = executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit;
    const { changedPaths, diff } = preview;
    if (!diff.trim()) throw new Error("No approved task diff exists relative to the reviewed source baseline.");
    return {
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      baselineHeadCommit: baseline,
      changedPaths,
      diff,
      diffHash: preview.diffHash,
      repositories: preview.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        repositoryRoot: repository.repositoryRoot,
        baselineHeadCommit: repository.baselineHeadCommit,
        changedPaths: repository.changedPaths,
        diffHash: repository.diffHash,
      })),
    };
  }

  reviewFinalDiff(expectedDiffHash: string): FinalDiffReview {
    const preview = this.previewFinalDiff();
    if (preview.diffHash !== expectedDiffHash) {
      throw new Error("The task diff changed while it was being reviewed; preview and review the current diff again.");
    }
    const snapshot = this.repository.snapshot();
    const review: FinalDiffReview = {
      id: newId("diff-review"),
      taskId: preview.taskId,
      executionGrantId: preview.executionGrantId,
      baselineHeadCommit: preview.baselineHeadCommit,
      snapshot,
      changedPaths: preview.changedPaths,
      diffHash: preview.diffHash,
      repositoryBindings: this.repositoryRevisionBindings(),
      ...(preview.repositories === undefined ? {} : { repositories: preview.repositories }),
      reviewedAt: nowIso(),
    };
    this.ledger.setState(`finalDiffReview:${preview.executionGrantId}`, review);
    this.ledger.append({
      kind: "repository.final_diff_reviewed",
      actor: "user",
      taskId: preview.taskId,
      repositorySnapshot: snapshot,
      payload: review,
    });
    return review;
  }

  commitActiveTask(message: string, actor: "user" | "agent" = "user"): WorkspaceCommitResult {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("A local task change requires an active execution grant.");
    const snapshot = this.repository.snapshot();
    const repositories = this.workspaceRepositories(executionGrant);
    const changes = repositories.approvedChanges(false).filter((entry) => entry.changedPaths.length > 0);
    if (changes.length === 0) throw new Error("No approved source changes are available to commit.");
    const absolutePaths = changes.flatMap((entry) => entry.absolutePaths);
    const decision = this.evaluateWorkflow({
      action: "repository.change.create",
      risk: "routine",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      paths: absolutePaths,
      rationale: "Create the local repository change required by the approved task.",
    });
    if (decision.result !== "allow") throw new Error(decision.reason);
    let result: WorkspaceCommitResult;
    try {
      result = repositories.commit(message);
    } catch (error) {
      this.ledger.append({
        kind: "repository.change_partial_failure",
        actor,
        taskId: executionGrant.taskId,
        repositorySnapshot: this.repository.snapshot(),
        payload: { message, error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    this.ledger.append({
      kind: "repository.change_created",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: result.snapshot,
      payload: {
        message: result.message,
        changedPaths: result.changedPaths,
        baselineHeadCommit: executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit,
        repositories: result.repositories.map((repository) => ({
          repositoryId: repository.repositoryId,
          repositoryRoot: repository.repositoryRoot,
          changedPaths: repository.result.changedPaths,
          snapshot: repository.result.snapshot,
        })),
      },
    });
    return result;
  }

  taskClosureReadiness(): TaskClosureReadiness {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) {
      const completed = this.currentWorkflowRun()?.checkpoint === "completed";
      const readiness: TaskClosureReadiness = {
        ready: completed,
        blockers: [], required: [], missing: [], stale: [], failed: [],
        reason: completed
          ? "The approved task is complete and its execution grant was revoked."
          : "No active task exists.",
      };
      delete this.cachedTaskClosure;
      return readiness;
    }
    const repositories = this.workspaceRepositories(executionGrant);
    const snapshot = repositories.evidenceSnapshot();
    const validation = this.validation.closureReadiness(snapshot, executionGrant.taskId, executionGrant.id);
    const policy = this.validation.closurePolicy();
    const review = this.currentFinalDiffReview();
    let diffHash: string | undefined;
    try {
      diffHash = repositories.diff(true).diffHash;
    } catch {
      diffHash = undefined;
    }
    const finalDiffReviewed = !policy.requireFinalDiffReview
      || (review !== undefined
        && review.taskId === executionGrant.taskId
        && review.executionGrantId === executionGrant.id
        && review.baselineHeadCommit === (executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit)
        && diffHash !== undefined
        && review.diffHash === diffHash);
    const localChangeCreated = !policy.requireLocalChange || repositories.localChangeCreated();
    let sourceStateAcceptable = true;
    let repositoryMetadataPaths: string[] = [];
    try {
      sourceStateAcceptable = !policy.requireCleanSource || repositories.sourceClean();
      repositoryMetadataPaths = repositories.metadataState().qualifiedPaths;
    } catch {
      sourceStateAcceptable = false;
      repositoryMetadataPaths = [];
    }
    const repositoryFinalizationRequired = policy.requireCleanRepository && repositoryMetadataPaths.length > 0;
    const missing = [...validation.missing];
    const stale = [...validation.stale];
    const failed = [...validation.failed];
    const blockers = [...validation.blockers];
    if (!finalDiffReviewed) {
      missing.push("current final diff review");
      blockers.push({ code: "diff_review_missing", detail: "The exact current approved-path diff has not been reviewed." });
    }
    if (!localChangeCreated) {
      missing.push("local committed change");
      blockers.push({ code: "local_change_missing", detail: "No local commit or finalized Jujutsu change exists for the task." });
    }
    if (!sourceStateAcceptable) {
      missing.push("clean application-source state");
      blockers.push({ code: "source_dirty", detail: "Approved application-source paths remain dirty." });
    }
    const ready = validation.ready && finalDiffReviewed && localChangeCreated && sourceStateAcceptable;
    const readiness: TaskClosureReadiness = {
      ready,
      blockers,
      validationReady: validation.ready,
      finalDiffReviewed,
      localChangeCreated,
      repositoryStateAcceptable: sourceStateAcceptable,
      repositoryFinalizationRequired,
      repositoryMetadataPaths,
      required: validation.required,
      missing,
      stale,
      failed,
      reason: ready
        ? repositoryFinalizationRequired
          ? `Source completion evidence is satisfied; Atelier will finalize workflow metadata (${repositoryMetadataPaths.join(", ")}) during task closure.`
          : "Required validation, final diff review, local change, and source state are complete."
        : `Task closure blocked: ${[
            validation.ready ? "" : validation.reason.replace(/^Task closure blocked:\s*/i, "").replace(/\.$/, ""),
            finalDiffReviewed ? "" : "the current diff has not been reviewed",
            localChangeCreated ? "" : "no local commit or finalized change exists",
            sourceStateAcceptable ? "" : "approved application-source paths are not clean",
          ].filter(Boolean).join("; ")}.`,
    };
    this.cachedTaskClosure = { executionGrantId: executionGrant.id, readiness };
    return readiness;
  }

  async closeActiveTask(reason: string, actor: "user" | "agent" = "user"): Promise<{ task: TaskRecord; nextReady: TaskRecord[] }> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("No active execution task is available to close.");
    const repositories = this.workspaceRepositories(executionGrant);
    const snapshot = this.repository.snapshot();
    const workspaceSnapshot = repositories.evidenceSnapshot();
    const decision = this.evaluateWorkflow({
      action: "task.close",
      risk: "routine",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      rationale: reason,
    });
    if (decision.result !== "allow") throw new Error(decision.reason);

    // Preserve the exact evidence snapshot that authorized closure. Repository
    // and provider finalization may legitimately change raw VCS state after this
    // point, but must never rewrite the decision that allowed the task to close.
    const closureDecision = this.taskClosureReadiness();
    if (!closureDecision.ready) throw new Error(closureDecision.reason);

    const beforeProviderPaths = repositories.rawChangedPaths();
    const beforeProviderFingerprints = repositories.rawChangedFingerprints();
    const task = await this.taskProvider.close(executionGrant.taskId, reason);
    const afterProviderPaths = repositories.rawChangedPaths();
    const providerCandidates = [...new Set([...beforeProviderPaths, ...afterProviderPaths])].sort();
    const afterProviderFingerprints = repositories.rawChangedFingerprints();
    const providerMutationPaths = providerCandidates.filter((path) =>
      beforeProviderFingerprints[path] !== afterProviderFingerprints[path]
      || beforeProviderPaths.includes(path) !== afterProviderPaths.includes(path));

    const policy = this.validation.closurePolicy();
    let metadataChanges: ReturnType<WorkspaceRepositoryService["commitMetadata"]> = [];
    if (policy.requireCleanRepository) {
      try {
        metadataChanges = repositories.commitMetadata(`chore(atelier): finalize workflow for ${task.id}`);
        const remaining = repositories.rawChangedPaths();
        if (remaining.length > 0) {
          throw new Error(`Task provider closed ${task.id}, but repository finalization left tracked changes: ${remaining.join(", ")}`);
        }
      } catch (error) {
        this.ledger.append({
          kind: "task.finalization_failed",
          actor,
          taskId: task.id,
          repositorySnapshot: this.repository.snapshot(),
          payload: {
            reason,
            providerMutationPaths,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }
    const closedSnapshot = this.repository.snapshot();
    const closedWorkspaceSnapshot = repositories.evidenceSnapshot();
    const workflowFinalizationPaths = metadataChanges.flatMap((change) =>
      change.result.changedPaths.map((path) => repositories.qualify(change.repositoryId, path)));
    this.ledger.append({
      kind: "task.closed",
      actor,
      taskId: task.id,
      repositorySnapshot: closedSnapshot,
      payload: {
        reason,
        completion: closureDecision,
        finalization: {
          providerMutationPaths,
          workflowFinalizationPaths,
          repositoryClean: repositories.rawChangedPaths().length === 0,
          sourceFingerprintBefore: sourceSnapshotFingerprint(workspaceSnapshot),
          sourceFingerprintAfter: sourceSnapshotFingerprint(closedWorkspaceSnapshot),
        },
        ...(metadataChanges.length === 0 ? {} : {
          metadataChanges: metadataChanges.map((change) => ({
            repositoryId: change.repositoryId,
            repositoryRoot: change.repositoryRoot,
            message: change.result.message,
            changedPaths: change.result.changedPaths,
          })),
        }),
      },
    });
    this.execution.cancel(`Task ${task.id} was explicitly closed.`, "completed");
    const mappings = new Set(this.ledger.listTaskMappings()
      .filter((mapping) => mapping.provider === this.taskProvider.name && mapping.planHash === executionGrant.planHash)
      .map((mapping) => mapping.providerTaskId));
    const nextReady = (await this.taskProvider.ready()).filter((candidate) => mappings.has(candidate.id));
    return { task, nextReady };
  }

  async observeTaskClosure(): Promise<TaskRecord[]> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) return [];
    const task = await this.taskProvider.get(executionGrant.taskId);
    if (task === undefined || task.status !== "closed") return [];
    const readiness = this.taskClosureReadiness();
    if (!readiness.ready) {
      this.ledger.append({
        kind: "task.external_closure_detected",
        actor: "system",
        taskId: task.id,
        repositorySnapshot: this.repository.snapshot(),
        payload: { readiness },
      });
      this.ledger.invalidateExecutionGrant(executionGrant.id, {
        status: "invalidated",
        reason: `Task ${task.id} was closed outside Atelier before completion evidence was satisfied: ${readiness.reason}`,
      });
      return [];
    }
    if (this.validation.closurePolicy().requireCleanRepository) {
      const repositories = this.workspaceRepositories(executionGrant);
      try {
        const metadataChanges = repositories.commitMetadata(`chore(atelier): finalize workflow for ${task.id}`);
        const remaining = repositories.rawChangedPaths();
        if (remaining.length > 0) {
          throw new Error(`Externally closed task ${task.id} still has tracked workflow metadata: ${remaining.join(", ")}`);
        }
        if (metadataChanges.length > 0) {
          this.ledger.append({
            kind: "task.external_closure_finalized",
            actor: "system",
            taskId: task.id,
            repositorySnapshot: this.repository.snapshot(),
            payload: {
              metadataChanges: metadataChanges.map((change) => ({
                repositoryId: change.repositoryId,
                repositoryRoot: change.repositoryRoot,
                message: change.result.message,
                changedPaths: change.result.changedPaths,
              })),
            },
          });
        }
      } catch (error) {
        this.ledger.append({
          kind: "task.external_closure_finalization_failed",
          actor: "system",
          taskId: task.id,
          repositorySnapshot: this.repository.snapshot(),
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
        return [];
      }
    }
    this.execution.cancel(`Task ${task.id} was explicitly closed through an authorized typed tool.`, "completed");
    const mappings = new Set(this.ledger.listTaskMappings()
      .filter((mapping) => mapping.provider === this.taskProvider.name && mapping.planHash === executionGrant.planHash)
      .map((mapping) => mapping.providerTaskId));
    return (await this.taskProvider.ready()).filter((candidate) => mappings.has(candidate.id));
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

  approvePlan(): never {
    const plan = this.parsePlan();
    const errors = plan.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length > 0) {
      throw new Error(`Plan cannot be approved: ${errors.map((error) => error.message).join("; ")}`);
    }
    const reviewedPlanHash = this.ledger.getState<string>("reviewedPlanHash");
    if (reviewedPlanHash !== plan.hash) {
      throw new Error("Plan cannot be approved until the current revision has been reviewed in the configured editor.");
    }
    throw new Error(
      "Direct plan approval is not supported. Prepare and approve the exact execution transaction so source, retrieval, task reconciliation, and capabilities are approved together.",
    );
  }

  async reconcilePlan(apply = false, approvedPreview?: TaskReconciliation): Promise<TaskReconciliation> {
    if (apply) {
      throw new Error("Task reconciliation mutation requires an exact ExecutionWorkflowCoordinator approval transaction.");
    }
    const plan = this.parsePlan();
    const reconciler = new PlanReconciler(this.taskProvider, this.ledger);
    const preview = approvedPreview ?? await reconciler.preview(plan);
    return preview;
  }

  beginRetrievalSession(sessionId?: string): string {
    return sessionId === undefined
      ? this.code.beginRetrievalSession()
      : this.code.beginRetrievalSession(sessionId);
  }

  endRetrievalSession(): string {
    return this.code.endRetrievalSession();
  }

  private repositoryProviderForRoot(root: string): RepositoryProvider {
    const canonical = resolveAccessPath(root, "read");
    if (canonical === resolveAccessPath(this.config.repositoryRoot, "read")) return this.repository;
    const existing = this.workspaceRepositoryProviders.get(canonical);
    if (existing !== undefined) return existing;
    const created = createRepositoryProvider(this.config, this.ledger, canonical);
    this.workspaceRepositoryProviders.set(canonical, created);
    return created;
  }

  async observeCodeWorkspace(options: {
    force?: boolean;
    signal?: AbortSignal;
    operation?: string;
    primaryObservation?: RepositoryObservation;
  } = {}): Promise<CodeWorkspace> {
    if (this.codeWorkspacePromise !== undefined && options.force !== true) return this.codeWorkspacePromise;
    const generation = this.repositoryObservationGeneration;
    const pending = (async () => {
      const primary = options.primaryObservation ?? await this.observeRepository({
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        operation: options.operation ?? "code-workspace",
      });
      const workspace = await loadCodeWorkspaceAsync(this.config.repositoryRoot, primary.snapshot, {
        workspacePath: this.config.workspacePath,
        rootWithinWorkspace: (root) => isPathWithin(root, this.config.workspaceRoot, "read"),
        snapshotForRoot: async (root) => {
          const provider = this.repositoryProviderForRoot(root);
          if (provider.observe !== undefined) {
            return (await provider.observe({
              ...(options.force === undefined ? {} : { force: options.force }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })).snapshot;
          }
          return provider.snapshot();
        },
      });
      if (generation === this.repositoryObservationGeneration) this.lastCodeWorkspace = workspace;
      return workspace;
    })();
    if (options.force !== true) this.codeWorkspacePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.codeWorkspacePromise === pending) delete this.codeWorkspacePromise;
    }
  }

  codeWorkspace(): CodeWorkspace {
    const primary = this.repository.peekObservation?.()?.snapshot;
    if (this.lastCodeWorkspace !== undefined && primary !== undefined) {
      const current = this.lastCodeWorkspace.repositories.find((repository) => repository.root === this.config.repositoryRoot)?.snapshot;
      if (current !== undefined && sourceRevisionIdentity(current) === sourceRevisionIdentity(primary)) {
        return this.lastCodeWorkspace;
      }
    }
    const snapshot = primary ?? this.repository.snapshot();
    const workspace = loadCodeWorkspace(this.config.repositoryRoot, snapshot, {
      workspacePath: this.config.workspacePath,
      rootWithinWorkspace: (root) => isPathWithin(root, this.config.workspaceRoot, "read"),
      snapshotForRoot: (root) => {
        const provider = this.repositoryProviderForRoot(root);
        return provider.peekObservation?.()?.snapshot ?? provider.snapshot();
      },
    });
    this.lastCodeWorkspace = workspace;
    return workspace;
  }

  repositoryRevisionBindings(): RepositoryRevisionBinding[] {
    return this.codeWorkspace().repositories.map((repository) =>
      repositoryRevisionBinding(repository.id, repository.snapshot));
  }

  validateConfiguration(): string[] {
    const issues = validateCodeWorkspace(this.codeWorkspace());
    try {
      const manifest = this.validation.manifest();
      if (this.validation.closurePolicy().requireValidation
        && !Object.values(manifest.validations).some((definition) => definition.required === true)) {
        issues.push("Validation closure requires at least one validation with required: true");
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    if (this.config.codeTimeoutMs < 1) issues.push("codeTimeoutMs must be positive");
    if (this.config.codeIndexTimeoutMs < 1) issues.push("codeIndexTimeoutMs must be positive");
    if (this.config.codeMaxResults < 1) issues.push("codeMaxResults must be positive");
    for (const name of [
      "codeMaxProviderRequests",
      "codeMaxUniquePaths",
      "codeMaxEvidenceEntries",
      "codeRetainedSessions",
      "codeMaxPersistedEntries",
      "codeMaxPersistedBytes",
    ] as const) {
      const value = this.config[name];
      if (!Number.isInteger(value) || value < 1) issues.push(`${name} must be a positive integer`);
    }
    if (this.config.codeMaxUniquePaths > this.config.codeMaxEvidenceEntries) issues.push("codeMaxUniquePaths must be <= codeMaxEvidenceEntries");
    if (this.config.codeMaxEvidenceEntries > this.config.codeMaxPersistedEntries) issues.push("codeMaxEvidenceEntries must be <= codeMaxPersistedEntries");
    if (this.config.codeMaxEvidenceEntries + this.config.codeMaxProviderRequests > this.config.codeMaxPersistedEntries) {
      issues.push("codeMaxPersistedEntries must cover codeMaxEvidenceEntries plus codeMaxProviderRequests");
    }
    if (this.config.codeMaxTotalBytes < this.config.codeMaxChunkBytes) issues.push("codeMaxTotalBytes must be >= codeMaxChunkBytes");
    if (this.config.codeMaxPersistedBytes < this.config.codeMaxTotalBytes) issues.push("codeMaxPersistedBytes must be >= codeMaxTotalBytes");
    return issues;
  }

  async buildWorkingState(explicitTaskId?: string): Promise<WorkingState> {
    const plan = existsSync(this.config.planPath) ? this.parsePlan() : undefined;
    const workspace = await this.observeCodeWorkspace({ force: true, operation: "workflow-full" });
    const repositories = this.workspaceRepositories(this.ledger.getActiveExecutionGrant(), workspace);
    const snapshot = repositories.evidenceSnapshot();
    const built = await this.workingStateBuilder.build({
      mode: this.mode(),
      snapshot,
      changedPaths: repositories.sourceChangedPaths(),
      workspace,
      ...(plan === undefined ? {} : { plan }),
      ...(explicitTaskId === undefined ? {} : { explicitTaskId }),
    });
    const finalDiffReview = this.currentFinalDiffReview();
    const state: WorkingState = {
      ...built,
      nextAction: await this.nextAction(),
      taskClosure: this.taskClosureReadiness(),
      ...(finalDiffReview === undefined ? {} : { finalDiffReview }),
    };
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
        ...(state.retrievalSession === undefined ? {} : {
          retrievalSession: {
            id: state.retrievalSession.id,
            inventoryCount: state.retrievalSession.inventory.length,
            budget: state.retrievalSession.budget,
            telemetry: state.retrievalSession.telemetry,
            persistence: state.retrievalSession.persistence,
            invalidationCount: state.retrievalSession.invalidations.length,
          },
        }),
        omissions: state.omissions,
      },
    });
    return state;
  }

  async nextAction(options: { taskClosure?: TaskClosureReadiness; allowProviderIo?: boolean } = {}): Promise<string> {
    const allowProviderIo = options.allowProviderIo !== false;
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant !== undefined) {
      if (this.execution.isPaused()) return `Execution is paused for task ${executionGrant.taskId}; resume explicitly before agent mutation.`;
      const readiness = options.taskClosure
        ?? (allowProviderIo ? this.taskClosureReadiness() : undefined);
      if (readiness === undefined) {
        return `Continue executing active task ${executionGrant.taskId}; use /workflow refresh before closure to evaluate current evidence.`;
      }
      if (readiness.ready) return `Close active task ${executionGrant.taskId} with explicit completion evidence.`;
      const codes = new Set(readiness.blockers.map((blocker) => blocker.code));
      if (codes.has("validation_selection_missing")) return `Select focused validation for task ${executionGrant.taskId}.`;
      if (["validation_evidence_missing", "validation_evidence_stale", "validation_failed", "validation_no_required_match", "validation_not_configured"].some((code) => codes.has(code as any))) {
        return `Run or rerun required focused validation: ${readiness.reason}`;
      }
      if (codes.has("local_change_missing")) return `Create the reviewed local change for task ${executionGrant.taskId}.`;
      if (codes.has("diff_review_missing")) return `Review the exact current diff for task ${executionGrant.taskId}.`;
      if (codes.has("source_dirty")) return `Finish or finalize approved source work for task ${executionGrant.taskId}.`;
      return `Continue executing active task ${executionGrant.taskId}: ${readiness.reason}`;
    }
    const previousGrant = this.ledger.listExecutionGrants()[0];
    if (previousGrant?.status === "revoked") {
      if (!allowProviderIo) {
        return `Resume or reconcile previously active task ${previousGrant.taskId}.`;
      }
      try {
        const task = await this.taskProvider.get(previousGrant.taskId);
        if (task?.status === "in_progress") {
          return `Prepare a fresh exact transaction to resume task ${task.id}, or explicitly close/defer it in the task provider.`;
        }
      } catch (error) {
        return `Restore task-provider availability before continuing: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const approval = this.ledger.listPlanApprovals()[0];
    if (approval?.status === "prepared") {
      return `Inspect and explicitly approve prepared transaction ${approval.id} with digest ${approval.reconciliationDigest}.`;
    }
    const workflow = this.currentWorkflowRun();
    if (workflow?.checkpoint === "reviewed") return "Prepare and approve the exact reviewed plan transaction.";
    if (workflow !== undefined && ["drafting", "review_pending", "reviewing"].includes(workflow.checkpoint)) {
      return `Complete ManualEdit review of ${this.config.planPath}.`;
    }
    if (approval?.status === "approved") {
      if (!allowProviderIo) return "Explicitly execute the next approved-plan task.";
      try {
        const mappedTaskIds = new Set(this.ledger.listTaskMappings()
          .filter((mapping) => mapping.provider === this.taskProvider.name && mapping.planHash === approval.planHash)
          .map((mapping) => mapping.providerTaskId));
        const ready = (await this.taskProvider.ready()).filter((task) => mappedTaskIds.has(task.id));
        if (ready.length > 0) return `Explicitly execute the next approved-plan task (${ready.map((task) => task.id).join(", ")}).`;
      } catch (error) {
        return `Restore task-provider availability before continuing: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return `Start or resume planning in ${this.config.planPath}.`;
  }

  async status(): Promise<AtelierStatus> {
    return this.performance.measure("/status", "total", async () => this.buildStatus());
  }

  private async buildStatus(): Promise<AtelierStatus> {
    const planExists = existsSync(this.config.planPath);
    const approvedPlanHash = this.ledger.getState<string>("approvedPlanHash");
    const planObjective = this.ledger.getState<string>("planObjective");
    const currentTaskId = this.ledger.getState<string>("currentTaskId");
    let taskProvider: TaskProviderStatus;
    try {
      taskProvider = this.taskProvider.peekStatus?.() ?? await this.performance.measure(
        "/status",
        "task-provider.status",
        () => this.taskProvider.status(),
      );
    } catch (error) {
      taskProvider = {
        provider: this.taskProvider.name,
        available: false,
        initialized: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const currentPlanHash = planExists ? hashFile(this.config.planPath) : undefined;
    const activeExecutionGrant = this.ledger.getActiveExecutionGrant();
    let currentTaskTitle: string | undefined;
    if (currentTaskId !== undefined && taskProvider.available && taskProvider.initialized) {
      currentTaskTitle = this.taskProvider.peekTask?.(currentTaskId)?.title;
    }
    const repositoryObservation = await this.observeRepository({ operation: "status" });
    const snapshot = repositoryObservation.snapshot;
    const repositoryDisplay = repositoryObservation.displayState;
    const codeWorkspace = await this.observeCodeWorkspace({
      primaryObservation: repositoryObservation,
      operation: "status",
    });
    const workspaceSourceDigest = codeWorkspace.repositories
      .map((repository) => `${repository.id}:${sourceRevisionIdentity(repository.snapshot)}`)
      .sort()
      .join("\n");
    const planStatus = !planExists
      ? "missing" as const
      : currentPlanHash !== undefined && approvedPlanHash !== undefined && currentPlanHash === approvedPlanHash
        ? "approved" as const
        : "not_approved" as const;
    const taskClosure = activeExecutionGrant === undefined
      ? undefined
      : this.cachedTaskClosure?.executionGrantId === activeExecutionGrant.id
        ? this.cachedTaskClosure.readiness
        : undefined;
    return {
      repositoryRoot: this.config.repositoryRoot,
      workspaceRoot: this.config.workspaceRoot,
      workspaceSource: this.config.workspaceSource,
      runtimeDirectory: this.config.runtimeDirectory,
      mode: this.mode(),
      planPath: this.config.planPath,
      planExists,
      planStatus,
      ...(approvedPlanHash === undefined ? {} : { approvedPlanHash }),
      ...(currentPlanHash === undefined ? {} : { currentPlanHash }),
      ...(planObjective === undefined || planObjective === "" ? {} : { planObjective }),
      ...(currentTaskId === undefined ? {} : { currentTaskId }),
      ...(currentTaskTitle === undefined || currentTaskTitle === "" ? {} : { currentTaskTitle }),
      ...(activeExecutionGrant === undefined ? {} : { activeExecutionGrant }),
      taskProvider,
      snapshot,
      repositoryDisplay,
      workspaceSourceDigest,
      activeTaskConstraints: this.activeTaskConstraints(),
      workflowCheckpoint: this.currentWorkflowRun()?.checkpoint ?? "none",
      closureStatus: activeExecutionGrant === undefined
        ? this.currentWorkflowRun()?.checkpoint === "completed" ? "completed" : "not applicable — no active task"
        : taskClosure === undefined
          ? "pending — closure evidence has not been refreshed"
          : taskClosure.ready ? "ready" : `blocked — ${taskClosure.reason}`,
      nextAction: await this.nextAction({
        ...(taskClosure === undefined ? {} : { taskClosure }),
        allowProviderIo: false,
      }),
    };
  }

  async close(): Promise<void> {
    await this.code.close();
    this.ledger.close();
  }

  async evaluateWorkspaceEffectsAsync(
    effects: readonly FilesystemEffect[],
    options: { observation?: RepositoryObservation; signal?: AbortSignal; operation?: string } = {},
  ): Promise<{ decision: WorkspacePolicyDecision; observation: RepositoryObservation }> {
    const paths = effects.flatMap((effect) => effect.path === undefined ? [] : [effect.path]);
    const observation = options.observation ?? await this.observeRepository({
      paths,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      operation: options.operation ?? "workspace-policy",
    });
    const decision = this.workspacePolicy.evaluate(effects, {
      classify: (path) => observation.pathStates[path]
        ?? this.repository.classifyPath?.(path)
        ?? (existsSync(path) ? "untracked" : "missing"),
    });
    return { decision, observation };
  }

  evaluateWorkspaceEffects(effects: readonly FilesystemEffect[]): WorkspacePolicyDecision {
    return this.workspacePolicy.evaluate(effects, { classify: (path) => this.repository.classifyPath?.(path) ?? (existsSync(path) ? "untracked" : "missing") });
  }

  checkpointWorkspaceEffects(
    decision: WorkspacePolicyDecision,
    options: {
      toolCallId?: string;
      sessionId?: string;
      repositorySnapshot?: RepositoryObservation["snapshot"];
    } = {},
  ): RecoveryCheckpoint {
    const checkpoint = this.recovery.checkpoint(
      decision.effects.filter((effect) => effect.decision === "checkpoint_then_allow"),
      options,
    );
    this.invalidateRepositoryObservation();
    this.ledger.append({
      kind: "recovery.checkpoint_created",
      actor: "system",
      repositorySnapshot: options.repositorySnapshot ?? this.repository.snapshot(),
      payload: checkpoint,
    });
    return checkpoint;
  }

  restoreCheckpoint(id: string): string[] {
    const paths = this.recovery.restore(id);
    this.ledger.append({ kind: "recovery.checkpoint_restored", actor: "user", repositorySnapshot: this.repository.snapshot(), payload: { id, paths } });
    return paths;
  }
}

function positiveOrOne(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
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
    stateDirectory: join(config.runtimeDirectory, "code"),
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
