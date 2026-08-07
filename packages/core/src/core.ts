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
  QualityGateClosureState,
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
import { DstackLifecycleCoordinator } from "./workflow/dstack-lifecycle-coordinator.ts";
import { constraintsForPlanTask, executionBaselineDigest, sourceBaselineMismatch } from "./workflow/execution-baseline.ts";
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
import { sourceRevisionIdentity, sourceSnapshotFingerprint, type RepositorySnapshot } from "./repository/snapshot.ts";
import {
  MAX_COMMIT_FAILURE_ATTEMPTS,
  CommitFailureError,
  classifyCommitFailure,
  commitAttemptState,
  commitFailureMessage,
  type CommitAttemptState,
  type CommitFailureDecision,
} from "./repository/commit-failure.ts";
import { ValidationService } from "./validation/validation-service.ts";
import {
  QualityGateService,
  qualityGatePlanningInventory,
  QualityGatePolicyError,
  type QualityGateBypassAuthorization,
  type QualityGateEvidence,
  type QualityGateEvidenceOperation,
  type QualityGatePlanInventory,
} from "./quality-gates/quality-gate-provider.ts";
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
import { isPathWithin, resolveAccessPath, sameAccessEntryPath } from "./security/path-boundary.ts";
import { redactText } from "./security/redaction.ts";
import { isSourcePath, sourcePaths } from "./repository/source-path.ts";
import { repositoryPathTarget, repositoryPathTargets, repositoryRelativePath } from "./repository/repository-path.ts";
import {
  repositoryRevisionBinding,
  type RepositoryRevisionBinding,
} from "./repository/revision-binding.ts";
import { WorkspacePolicyEvaluator, type FilesystemEffect, type WorkspacePolicyDecision } from "./policy/workspace-policy.ts";
import { RecoveryManager, type RecoveryCheckpoint } from "./recovery/recovery-manager.ts";
import { PerformanceRecorder } from "./performance/performance-recorder.ts";
import { octocodeCredentialEnvironment } from "./process/environment.ts";
import {
  buildContextCapsule,
  contextBoundaryDigest,
  stableJson,
  ContextCapsuleCache,
  type ContextCapsule,
  type ContextCapsuleBudgets,
  type ContextCapsuleSectionInput,
  type ContextCapsuleSource,
} from "./context/context-capsule.ts";

export interface BuildContextCapsuleOptions {
  /** Select one task explicitly; otherwise use the same selection as Working State. */
  explicitTaskId?: string;
  /** Exact repository-relative documents supplied by an authoritative adapter. */
  documentPaths?: readonly string[];
  /** Already-inventoried repository quality gates; arbitrary file scraping is not performed. */
  gateInventory?: unknown;
  budgets?: Partial<ContextCapsuleBudgets>;
}

export interface AtelierStatus {
  repositoryRoot: string;
  workspaceRoot: string;
  workspaceSource: "startup_cwd" | "explicit";
  runtimeDirectory: string;
  securityMode: AtelierConfig["securityMode"];
  sandboxBackend: AtelierConfig["sandboxBackend"];
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
  readonly qualityGates: QualityGateService;
  readonly code: CodeService;
  readonly execution: ExecutionWorkflowCoordinator;
  readonly dstack: DstackLifecycleCoordinator;
  readonly workspacePolicy: WorkspacePolicyEvaluator;
  readonly recovery: RecoveryManager;
  readonly performance = new PerformanceRecorder();
  private readonly workspaceRepositoryProviders = new Map<string, RepositoryProvider>();
  private lastCodeWorkspace?: CodeWorkspace;
  private codeWorkspacePromise?: Promise<CodeWorkspace>;
  private repositoryObservationGeneration = 0;
  private cachedTaskClosure?: { executionGrantId: string; readiness: TaskClosureReadiness };
  private readonly contextCapsuleCache = new ContextCapsuleCache();
  private closePromise: Promise<void> | undefined;

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
    this.qualityGates = new QualityGateService({ root: config.repositoryRoot, repository: this.repository });
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
      qualityGates: this.qualityGates,
    });
    this.workingStateBuilder = new WorkingStateBuilder(taskProvider, ledger, this.code, this.validation);
    this.dstack = new DstackLifecycleCoordinator({
      provider: taskProvider,
      ledger,
      repository: this.repository,
      pauseExecution: (reason) => this.execution.pause(reason),
      resumeExecution: () => this.execution.resumePaused(),
    });
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
            securityMode: "core-only",
            sandboxBackend: "none",
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

  validationEvidenceIsHistorical(): boolean {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return false;
    return this.ledger.getPlanApproval(grant.planApprovalId)?.qualityGateMode === "quality-gates";
  }

  evaluateWorkflow(request: WorkflowActionRequest): WorkflowDecision {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const decision = this.workflowGuard.evaluate(request, {
      mode: this.mode(),
      workspaceRoot: this.config.workspaceRoot,
      repositoryRoot: this.config.repositoryRoot,
      planPath: this.config.planPath,
      ...(executionGrant === undefined ? {} : { executionGrant, executionPaused: this.execution.isPaused() }),
      taskConstraints: this.activeTaskConstraints(),
      ...(request.action === "task.close" ? { taskClosure: this.taskClosureReadiness({ deferQualityGate: true }) } : {}),
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
      ...(executionGrant.executionBaseline === undefined ? {} : { baselineDigest: executionGrant.executionBaseline.digest }),
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
      ...(executionGrant.executionBaseline === undefined ? {} : { baselineDigest: executionGrant.executionBaseline.digest }),
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
        ...(executionGrant.executionBaseline === undefined ? {} : { baselineDigest: executionGrant.executionBaseline.digest }),
      }),
    });
    const surfacedEvidence = this.validationEvidenceIsHistorical()
      ? { ...evidence, historical: true }
      : evidence;
    this.ledger.append({
      kind: "validation.completed",
      actor: "tool",
      ...(executionGrant === undefined ? {} : { taskId: executionGrant.taskId }),
      repositorySnapshot: snapshot,
      payload: {
        id: surfacedEvidence.id,
        name,
        status: surfacedEvidence.status,
        durationMs: surfacedEvidence.durationMs,
        ...(surfacedEvidence.historical ? { historical: true } : {}),
        ...(options.selectionId === undefined ? {} : { selectionId: options.selectionId }),
      },
    });
    return surfacedEvidence;
  }

  activeExecutionConstraints(): ApprovedTaskConstraint[] {
    return this.activeTaskConstraints();
  }

  approvedTaskPaths(): string[] {
    return [...new Set(this.activeExecutionConstraints().flatMap((constraint) => constraint.writePaths))].sort();
  }

  approvedDependencyPaths(): string[] {
    return [...new Set(this.activeExecutionConstraints().flatMap((constraint) => {
      const broadScope = constraint.writePaths.some((path) => sameAccessEntryPath(path, this.config.repositoryRoot, "write"));
      return [
        ...constraint.dependencyPaths,
        ...(broadScope && constraint.allowDependencyChanges ? [this.config.repositoryRoot] : []),
      ];
    }))].sort();
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
      approvedDependencyPaths: executionGrant === undefined ? [] : this.approvedDependencyPaths(),
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
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("Final diff review requires an active execution grant.");
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
      ...(executionGrant.executionBaseline === undefined ? {} : { baselineDigest: executionGrant.executionBaseline.digest }),
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

  private qualityGatePlanFor(executionGrant: ExecutionGrant): QualityGatePlanInventory | undefined {
    return this.ledger.getPlanApproval(executionGrant.planApprovalId)?.qualityGatePlan;
  }

  qualityGateEvidenceForActiveTask(): Partial<Record<QualityGateEvidenceOperation, QualityGateEvidence>> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) return {};
    const evidence: Partial<Record<QualityGateEvidenceOperation, QualityGateEvidence>> = {};
    for (const operation of ["commit", "closure"] as const) {
      const item = this.ledger.getState<QualityGateEvidence>(this.qualityGateEvidenceKey(executionGrant.id, operation));
      if (item !== undefined) evidence[operation] = item;
    }
    return evidence;
  }

  private qualityGateEvidenceKey(executionGrantId: string, operation: QualityGateEvidenceOperation): string {
    return `qualityGateEvidence:${executionGrantId}:${operation}`;
  }

  private qualityGateBypassKey(executionGrantId: string): string {
    return `qualityGateBypass:${executionGrantId}`;
  }

  authorizeQualityGateBypass(reason: string, actor: "user" = "user"): QualityGateBypassAuthorization {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("A quality-gate bypass requires an active execution grant.");
    const plan = this.qualityGatePlanFor(executionGrant);
    if (plan?.selectedGateId === undefined) throw new Error("The approved execution has no selected quality gate to bypass.");
    const evidence = this.ledger.getState<QualityGateEvidence>(this.qualityGateEvidenceKey(executionGrant.id, "commit"));
    if (evidence === undefined || evidence.gateId !== plan.selectedGateId || evidence.passed
      || ["failed", "unavailable", "cancelled", "timed_out", "blocked", "mutation_detected", "stale"].includes(evidence.status) === false) {
      throw new Error("A one-turn quality-gate bypass requires a current failed or blocked commit-gate result.");
    }
    const normalizedReason = redactText(reason).trim().slice(0, 1_024);
    if (!normalizedReason) throw new Error("A quality-gate bypass requires an explicit reason.");
    const snapshot = this.repository.snapshot();
    const authorization: QualityGateBypassAuthorization = {
      version: 1,
      id: newId("quality-gate-bypass"),
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      operation: "commit",
      gateId: plan.selectedGateId,
      profileDigest: evidence.profileDigest,
      planDigest: evidence.planDigest ?? plan.digest,
      sourceFingerprint: sourceSnapshotFingerprint(snapshot),
      reason: normalizedReason,
      actor,
      authorizedAt: nowIso(),
      expiresAfter: "next-commit-attempt",
    };
    this.ledger.setState(this.qualityGateBypassKey(executionGrant.id), authorization);
    this.ledger.append({
      kind: "quality_gate.bypass_authorized",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      payload: authorization,
    });
    return authorization;
  }

  private async consumeQualityGateBypass(
    executionGrant: ExecutionGrant,
    snapshot: RepositorySnapshot,
  ): Promise<QualityGateBypassAuthorization | undefined> {
    const key = this.qualityGateBypassKey(executionGrant.id);
    const authorization = this.ledger.getState<QualityGateBypassAuthorization>(key);
    if (authorization === undefined) return undefined;
    this.ledger.deleteState(key);
    const approvedPlan = this.qualityGatePlanFor(executionGrant);
    const profile = approvedPlan === undefined ? undefined : await this.qualityGates.discover();
    const currentPlan = approvedPlan === undefined || profile === undefined
      ? undefined
      : qualityGatePlanningInventory(profile, approvedPlan.plannedPaths);
    if (authorization.taskId !== executionGrant.taskId
      || authorization.executionGrantId !== executionGrant.id
      || authorization.operation !== "commit"
      || authorization.actor !== "user"
      || authorization.expiresAfter !== "next-commit-attempt"
      || authorization.sourceFingerprint !== sourceSnapshotFingerprint(snapshot)
      || approvedPlan?.selectedGateId !== authorization.gateId
      || currentPlan?.digest !== authorization.planDigest
      || profile?.digest !== authorization.profileDigest) {
      this.ledger.append({
        kind: "quality_gate.bypass_expired",
        actor: "system",
        taskId: executionGrant.taskId,
        repositorySnapshot: snapshot,
        payload: { authorization, reason: "The one-turn bypass no longer matches the active task or source snapshot." },
      });
      return undefined;
    }
    this.ledger.append({
      kind: "quality_gate.bypass_used",
      actor: "user",
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      payload: authorization,
    });
    return authorization;
  }

  private saveQualityGateEvidence(evidence: QualityGateEvidence): QualityGateEvidence {
    this.ledger.setState(this.qualityGateEvidenceKey(evidence.executionGrantId, evidence.operation), evidence);
    this.ledger.append({
      kind: "quality_gate.evidence_recorded",
      actor: "system",
      taskId: evidence.taskId,
      repositorySnapshot: evidence.snapshotAfter,
      payload: evidence,
    });
    return evidence;
  }

  private qualityGateDiffHash(repositories: WorkspaceRepositoryService): string {
    try {
      return repositories.diff(true).diffHash;
    } catch (error) {
      return `unavailable:${sha256(error instanceof Error ? error.message : String(error))}`;
    }
  }

  private async enforceQualityGate(
    executionGrant: ExecutionGrant,
    operation: QualityGateEvidenceOperation,
    repositories: WorkspaceRepositoryService,
  ): Promise<QualityGateEvidence | undefined> {
    const approvedPlan = this.qualityGatePlanFor(executionGrant);
    if (approvedPlan === undefined) return undefined;
    const before = repositories.evidenceSnapshot();
    const stagedDiffHashBefore = this.qualityGateDiffHash(repositories);
    const profile = await this.qualityGates.discover();
    const currentPlan = qualityGatePlanningInventory(profile, approvedPlan.plannedPaths);
    const selectedGate = approvedPlan.selectedGateId === undefined
      ? undefined
      : profile.gates.find((gate) => gate.id === approvedPlan.selectedGateId);
    const identityChanged = profile.digest !== approvedPlan.profileDigest
      || currentPlan.digest !== approvedPlan.digest
      || currentPlan.configDigest !== approvedPlan.configDigest;
    const now = nowIso();
    const staleEvidence = (): QualityGateEvidence => ({
      version: 1,
      id: newId("quality-gate-evidence"),
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      operation,
      ...(approvedPlan.selectedGateId === undefined ? {} : { gateId: approvedPlan.selectedGateId }),
      status: "stale",
      passed: false,
      profileDigest: profile.digest,
      configDigest: currentPlan.configDigest,
      planDigest: currentPlan.digest,
      tool: selectedGate?.tool ?? { name: "unknown", version: "unknown", available: false },
      ...(selectedGate?.command === undefined ? {} : { command: [...selectedGate.command] }),
      coverage: selectedGate?.coverage ?? { scope: "unknown", paths: [] },
      snapshotBefore: before,
      snapshotAfter: before,
      sourceFingerprintBefore: sourceSnapshotFingerprint(before),
      sourceFingerprintAfter: sourceSnapshotFingerprint(before),
      stagedDiffHashBefore,
      stagedDiffHashAfter: stagedDiffHashBefore,
      mutationDetected: false,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      reason: `Approved quality-gate identity is stale (profile ${approvedPlan.profileDigest} -> ${profile.digest}; plan ${approvedPlan.digest} -> ${currentPlan.digest}). Prepare and approve a fresh transaction.`,
    });
    if (identityChanged || (approvedPlan.selectedGateId !== undefined && selectedGate === undefined)) {
      const evidence = this.saveQualityGateEvidence(staleEvidence());
      throw new QualityGatePolicyError(evidence.reason ?? "The approved quality-gate identity is stale.", evidence);
    }

    if (approvedPlan.selectedGateId === undefined) {
      const finished = repositories.evidenceSnapshot();
      const evidence: QualityGateEvidence = this.saveQualityGateEvidence({
        version: 1,
        id: newId("quality-gate-evidence"),
        taskId: executionGrant.taskId,
        executionGrantId: executionGrant.id,
        operation,
        status: "no_gate",
        passed: false,
        profileDigest: profile.digest,
        configDigest: currentPlan.configDigest,
        planDigest: currentPlan.digest,
        tool: { name: "none", version: "none", available: false },
        coverage: { scope: "unknown", paths: [] },
        snapshotBefore: before,
        snapshotAfter: finished,
        sourceFingerprintBefore: sourceSnapshotFingerprint(before),
        sourceFingerprintAfter: sourceSnapshotFingerprint(finished),
        stagedDiffHashBefore,
        stagedDiffHashAfter: this.qualityGateDiffHash(repositories),
        mutationDetected: false,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: now,
        finishedAt: nowIso(),
        durationMs: 0,
        reason: "No runnable repository quality gate was discovered; the approved transaction explicitly permits the no-gate policy.",
      });
      return evidence;
    }

    const changedPaths = this.repository.changedPaths();
    const run = await this.qualityGates.run(approvedPlan.selectedGateId, {
      profile,
      changedPaths,
    });
    const after = repositories.evidenceSnapshot();
    const stagedDiffHashAfter = this.qualityGateDiffHash(repositories);
    const mutationDetected = run.mutationDetected
      || sourceSnapshotFingerprint(before) !== sourceSnapshotFingerprint(after)
      || stagedDiffHashBefore !== stagedDiffHashAfter;
    const status = mutationDetected ? "mutation_detected" : run.status;
    const evidence: QualityGateEvidence = this.saveQualityGateEvidence({
      version: 1,
      id: newId("quality-gate-evidence"),
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      operation,
      gateId: approvedPlan.selectedGateId,
      status,
      passed: status === "passed",
      profileDigest: run.profileDigest,
      configDigest: run.configDigest,
      planDigest: currentPlan.digest,
      tool: { ...run.tool },
      ...(run.command === undefined ? {} : { command: [...run.command] }),
      coverage: { ...run.coverage, paths: [...run.coverage.paths] },
      runId: run.id,
      snapshotBefore: before,
      snapshotAfter: after,
      sourceFingerprintBefore: sourceSnapshotFingerprint(before),
      sourceFingerprintAfter: sourceSnapshotFingerprint(after),
      stagedDiffHashBefore,
      stagedDiffHashAfter,
      mutationDetected,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      stdout: run.stdout,
      stderr: run.stderr,
      stdoutTruncated: run.stdoutTruncated,
      stderrTruncated: run.stderrTruncated,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      ...(run.reason === undefined ? {} : { reason: run.reason }),
    });
    if (!evidence.passed) {
      throw new QualityGatePolicyError(
        `Quality gate ${evidence.gateId} did not pass (${evidence.status}). ${evidence.reason ?? "Inspect the recorded gate evidence before retrying."}`,
        evidence,
      );
    }
    return evidence;
  }

  private qualityGateClosureState(
    executionGrant: ExecutionGrant,
    repositories: WorkspaceRepositoryService,
    snapshot: RepositorySnapshot,
  ): QualityGateClosureState | undefined {
    const plan = this.qualityGatePlanFor(executionGrant);
    if (plan === undefined) return undefined;
    if (plan.selectedGateId === undefined) {
      return {
        required: false,
        ready: true,
        status: "no_gate",
        reason: "The approved execution transaction explicitly permits the discovered no-gate repository policy.",
      };
    }
    const evidence = this.ledger.getState<QualityGateEvidence>(this.qualityGateEvidenceKey(executionGrant.id, "closure"));
    if (evidence === undefined) {
      return {
        required: true,
        ready: false,
        gateId: plan.selectedGateId,
        reason: `Quality gate ${plan.selectedGateId} has not produced current closure evidence.`,
      };
    }
    let stagedDiffHash: string | undefined;
    try {
      stagedDiffHash = this.qualityGateDiffHash(repositories);
    } catch {
      stagedDiffHash = undefined;
    }
    const currentSource = sourceSnapshotFingerprint(snapshot);
    const current = evidence.status === "passed"
      && evidence.passed
      && !evidence.mutationDetected
      && evidence.profileDigest === plan.profileDigest
      && evidence.planDigest === plan.digest
      && evidence.sourceFingerprintBefore === currentSource
      && evidence.sourceFingerprintAfter === currentSource
      && stagedDiffHash !== undefined
      && !stagedDiffHash.startsWith("unavailable:")
      && !evidence.stagedDiffHashBefore.startsWith("unavailable:")
      && evidence.stagedDiffHashBefore === stagedDiffHash
      && evidence.stagedDiffHashAfter === stagedDiffHash;
    return {
      required: true,
      ready: current,
      status: evidence.status,
      gateId: plan.selectedGateId,
      evidenceId: evidence.id,
      reason: current
        ? `Quality gate ${plan.selectedGateId} passed with current closure evidence.`
        : `Quality gate ${plan.selectedGateId} evidence is ${evidence.status}; rerun the gate against the current source and staged diff.`,
    };
  }

  recordCommitFailureDecision(decision: Exclude<CommitFailureDecision, "pending">, actor: "user" | "agent" = "user"): CommitAttemptState | undefined {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) return undefined;
    const key = `commitAttempt:${executionGrant.id}`;
    const current = this.ledger.getState<CommitAttemptState>(key);
    if (current === undefined) return undefined;
    if (decision === "retry" && actor === "agent" && (!current.retryable || current.attempt >= MAX_COMMIT_FAILURE_ATTEMPTS)) {
      return current;
    }
    const updated: CommitAttemptState = {
      ...current,
      decision,
      decisionActor: actor,
      decisionAt: nowIso(),
    };
    this.ledger.setState(key, updated);
    this.ledger.append({
      kind: "repository.change_failure_decision",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: this.repository.snapshot(),
      payload: updated,
    });
    return updated;
  }

  async commitActiveTask(message: string, actor: "user" | "agent" = "user"): Promise<WorkspaceCommitResult> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("A local task change requires an active execution grant.");
    const snapshot = this.repository.snapshot();
    const repositories = this.workspaceRepositories(executionGrant);
    const changes = repositories.approvedChanges(false).filter((entry) => entry.changedPaths.length > 0);
    if (changes.length === 0) throw new Error("No approved source changes are available to commit.");
    const previousFailure = this.ledger.getState<CommitAttemptState>(`commitAttempt:${executionGrant.id}`);
    if (previousFailure !== undefined && previousFailure.decision !== "retry") {
      throw new CommitFailureError(
        `The previous ${previousFailure.category} commit failure requires an explicit retry, pause, cancel, or reviewed bypass decision.`,
        previousFailure,
        previousFailure.attempt >= MAX_COMMIT_FAILURE_ATTEMPTS,
      );
    }
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
    const qualityGateBypass = await this.consumeQualityGateBypass(executionGrant, snapshot);
    const qualityGateEvidence = qualityGateBypass === undefined
      ? await this.enforceQualityGate(executionGrant, "commit", repositories)
      : undefined;
    let result: WorkspaceCommitResult;
    try {
      result = repositories.commit(message);
    } catch (error) {
      const failureSnapshot = this.repository.snapshot();
      const classification = classifyCommitFailure(error);
      const configurationFingerprint = sha256(stableJson(this.config));
      const prior = this.ledger.getState<CommitAttemptState>(`commitAttempt:${executionGrant.id}`);
      const firstAttempt = commitAttemptState(
        executionGrant.taskId,
        executionGrant.id,
        classification,
        1,
        {
          sourceFingerprint: sourceSnapshotFingerprint(failureSnapshot),
          configurationFingerprint,
        },
      );
      const sameFailure = prior?.failureFingerprint === firstAttempt.failureFingerprint;
      const attempt = sameFailure ? prior.attempt + 1 : 1;
      const state = commitAttemptState(
        executionGrant.taskId,
        executionGrant.id,
        classification,
        attempt,
        {
          sourceFingerprint: sourceSnapshotFingerprint(failureSnapshot),
          configurationFingerprint,
        },
      );
      if (sameFailure && prior.attempt >= MAX_COMMIT_FAILURE_ATTEMPTS) {
        const exhausted: CommitAttemptState = {
          ...state,
          attempt: prior.attempt,
          decision: "pending",
        };
        delete exhausted.decisionActor;
        delete exhausted.decisionAt;
        this.ledger.setState(`commitAttempt:${executionGrant.id}`, exhausted);
        this.ledger.append({
          kind: "repository.change_retry_budget_exhausted",
          actor,
          taskId: executionGrant.taskId,
          repositorySnapshot: failureSnapshot,
          payload: {
            message,
            ...exhausted,
            budgetExhausted: true,
          },
        });
        throw new CommitFailureError(commitFailureMessage(exhausted, true), exhausted, true, error);
      }
      this.ledger.setState(`commitAttempt:${executionGrant.id}`, state);
      this.ledger.append({
        kind: "repository.change_partial_failure",
        actor,
        taskId: executionGrant.taskId,
        repositorySnapshot: failureSnapshot,
        payload: {
          message,
          ...state,
          budgetExhausted: false,
        },
      });
      throw new CommitFailureError(commitFailureMessage(state), state, false, error);
    }
    this.ledger.deleteState(`commitAttempt:${executionGrant.id}`);
    this.ledger.append({
      kind: "repository.change_created",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: result.snapshot,
      payload: {
        message: result.message,
        changedPaths: result.changedPaths,
        ...(qualityGateEvidence === undefined ? {} : { qualityGate: qualityGateEvidence }),
        ...(qualityGateBypass === undefined ? {} : { qualityGateBypass }),
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

  taskClosureReadiness(options: { deferQualityGate?: boolean } = {}): TaskClosureReadiness {
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
    const approval = this.ledger.getPlanApproval(executionGrant.planApprovalId);
    const validation = this.validation.closureReadiness(snapshot, executionGrant.taskId, executionGrant.id, {
      ...(approval?.qualityGateMode === "quality-gates" ? { qualityGateMode: "quality-gates" as const } : {}),
    });
    const policy = this.validation.closurePolicy();
    const review = this.currentFinalDiffReview();
    const activeConstraint = this.activeTaskConstraints()[0];
    const requiresLocalChange = policy.requireLocalChange && activeConstraint?.allowLocalChange !== false;
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
    let localChangeCreated = true;
    let localChangeError: string | undefined;
    try {
      localChangeCreated = !requiresLocalChange || repositories.localChangeCreated();
    } catch (error) {
      localChangeCreated = false;
      localChangeError = error instanceof Error ? error.message : String(error);
    }
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
    const qualityGate = this.qualityGateClosureState(executionGrant, repositories, snapshot);
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
      blockers.push({
        code: "local_change_missing",
        detail: localChangeError ?? "No local commit or finalized Jujutsu change exists for the task.",
      });
    }
    if (!sourceStateAcceptable) {
      missing.push("clean application-source state");
      blockers.push({ code: "source_dirty", detail: "Approved application-source paths remain dirty." });
    }
    if (qualityGate !== undefined && !qualityGate.ready && options.deferQualityGate !== true) {
      missing.push("current quality-gate evidence");
      if (qualityGate.status === "failed" || qualityGate.status === "cancelled" || qualityGate.status === "timed_out" || qualityGate.status === "unavailable" || qualityGate.status === "mutation_detected" || qualityGate.status === "blocked") {
        failed.push(qualityGate.gateId ?? "quality gate");
        blockers.push({ code: "quality_gate_failed", detail: qualityGate.reason });
      } else if (qualityGate.status === "stale") {
        stale.push(qualityGate.gateId ?? "quality gate");
        blockers.push({ code: "quality_gate_evidence_stale", detail: qualityGate.reason });
      } else {
        blockers.push({ code: "quality_gate_evidence_missing", detail: qualityGate.reason });
      }
    }
    const qualityGateReady = options.deferQualityGate === true || qualityGate === undefined || qualityGate.ready;
    const ready = validation.ready && finalDiffReviewed && localChangeCreated && sourceStateAcceptable && qualityGateReady;
    const readiness: TaskClosureReadiness = {
      ready,
      blockers,
      validationReady: validation.ready,
      finalDiffReviewed,
      localChangeCreated,
      repositoryStateAcceptable: sourceStateAcceptable,
      repositoryFinalizationRequired,
      repositoryMetadataPaths,
      ...(qualityGate === undefined ? {} : { qualityGate }),
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
            localChangeCreated ? "" : localChangeError ?? "no local commit or finalized change exists",
            sourceStateAcceptable ? "" : "approved application-source paths are not clean",
            qualityGateReady ? "" : qualityGate?.reason ?? "quality-gate evidence is incomplete",
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

    const qualityGateEvidence = await this.enforceQualityGate(executionGrant, "closure", repositories);

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
        ...(qualityGateEvidence === undefined ? {} : { qualityGate: qualityGateEvidence }),
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
    const repositories = this.workspaceRepositories(executionGrant);
    try {
      await this.enforceQualityGate(executionGrant, "closure", repositories);
    } catch (error) {
      this.ledger.append({
        kind: "task.external_closure_detected",
        actor: "system",
        taskId: task.id,
        repositorySnapshot: this.repository.snapshot(),
        payload: { qualityGateError: error instanceof Error ? error.message : String(error) },
      });
      this.ledger.invalidateExecutionGrant(executionGrant.id, {
        status: "invalidated",
        reason: `Task ${task.id} was closed outside Atelier before quality-gate evidence was satisfied: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
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

  private contextCapsulePreflightKey(options: BuildContextCapsuleOptions): string | undefined {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const currentTaskId = executionGrant?.taskId ?? this.ledger.getState<string>("currentTaskId");
    const task = currentTaskId === undefined
      ? undefined
      : this.taskProvider.peekTask?.(currentTaskId);
    const readyTasks = currentTaskId === undefined
      ? this.taskProvider.peekReady?.()
      : undefined;
    const providerObservation = currentTaskId === undefined
      ? readyTasks
      : task;
    // Do not reuse a capsule when the provider has no fresh read-only observation
    // with which to detect an external task/provider change.
    if (providerObservation === undefined) return undefined;
    const approvalId = executionGrant?.planApprovalId ?? this.ledger.getState<string>("currentPlanApprovalId");
    const approval = approvalId === undefined ? undefined : this.ledger.getPlanApproval(approvalId);
    const snapshot = this.repository.snapshot();
    const validationEvidence = this.validation.summaries(snapshot, [], currentTaskId);
    const state = {
      workflowMode: this.ledger.getState<WorkflowMode>("workflowMode"),
      planObjective: this.ledger.getState<string>("planObjective"),
      reviewedPlanHash: this.ledger.getState<string>("reviewedPlanHash"),
      currentManualEditId: this.ledger.getCurrentManualEdit()?.id,
      executionPause: this.ledger.getState<unknown>("executionPause"),
      workflowRunId: this.ledger.getState<string>("currentWorkflowRunId"),
      finalDiffReview: executionGrant === undefined
        ? undefined
        : this.ledger.getState<unknown>(`finalDiffReview:${executionGrant.id}`),
      qualityGateEvidence: executionGrant === undefined
        ? undefined
        : {
            commit: this.ledger.getState<unknown>(this.qualityGateEvidenceKey(executionGrant.id, "commit")),
            closure: this.ledger.getState<unknown>(this.qualityGateEvidenceKey(executionGrant.id, "closure")),
            bypass: this.ledger.getState<unknown>(this.qualityGateBypassKey(executionGrant.id)),
          },
      planApproval: approval,
      reconciliation: approval === undefined
        ? undefined
        : this.ledger.getApprovalReconciliationTransaction(approval.id),
      validationEvidence,
    };
    return contextBoundaryDigest({
      explicitTaskId: options.explicitTaskId,
      repository: this.config.repositoryRoot,
      sourceRevision: sourceRevisionIdentity(snapshot),
      plan: sourcePathFingerprint(this.config.repositoryRoot, this.config.planPath),
      validation: sourcePathFingerprint(this.config.repositoryRoot, this.config.validationPath),
      documents: (options.documentPaths ?? []).map((path) => ({
        path,
        fingerprint: sourcePathFingerprint(this.config.repositoryRoot, path),
      })),
      gateInventory: options.gateInventory,
      budgets: options.budgets ?? {},
      taskProvider: this.taskProvider.name,
      task,
      readyTasks,
      executionGrant,
      currentTaskId,
      state,
    });
  }

  async buildContextCapsule(options: BuildContextCapsuleOptions = {}): Promise<ContextCapsule> {
    const preflightKey = this.contextCapsulePreflightKey(options);
    const cached = preflightKey === undefined ? undefined : this.contextCapsuleCache.getCached(preflightKey);
    if (cached !== undefined) return cached;
    const state = await this.buildWorkingState(options.explicitTaskId);
    const omissions = [...state.omissions];
    const documentSources: ContextCapsuleSource[] = [];
    const documentValues: Array<{ path: string; content: string }> = [];
    const seenDocuments = new Set<string>();

    for (const requestedPath of options.documentPaths ?? []) {
      try {
        const target = repositoryPathTarget(this.config.repositoryRoot, requestedPath, "read");
        if (seenDocuments.has(target.relative)) continue;
        seenDocuments.add(target.relative);
        const content = readFileSync(target.entry, "utf8");
        const digest = sha256(content);
        documentSources.push({
          id: `document:${target.relative}`,
          kind: "document",
          digest,
          location: target.relative,
          boundary: "entire file",
          freshness: "current",
        });
        documentValues.push({ path: target.relative, content });
      } catch (error) {
        const location = requestedPath;
        const digest = sha256(`unavailable:${location}`);
        documentSources.push({
          id: `document:${location}`,
          kind: "document",
          digest,
          location,
          boundary: "read attempt",
          freshness: "unavailable",
        });
        omissions.push(`Document ${location} was unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const taskValue = {
      provider: this.taskProvider.name,
      activeTask: state.activeTask,
      planTask: state.planTask,
      taskSelection: state.taskSelection,
      readyTasks: state.readyTasks,
      taskDependencies: state.taskDependencies,
      taskBlockers: state.taskBlockers,
      taskConstraints: state.taskConstraints,
    };
    const retrievalValue = {
      queries: state.retrievalQueries,
      evidence: state.codeEvidence,
      session: state.retrievalSession,
      explanation: state.retrievalExplanation,
    };
    const snapshotIdentity = {
      repositoryId: state.snapshot.repositoryId,
      workspaceId: state.snapshot.workspaceId,
      vcs: state.snapshot.vcs,
      headCommit: state.snapshot.headCommit,
      sourceBaseCommit: state.snapshot.sourceBaseCommit,
      sourceFingerprint: state.snapshot.sourceFingerprint,
      dirtyFingerprint: state.snapshot.dirtyFingerprint,
      indexSchemaVersion: state.snapshot.indexSchemaVersion,
    };
    const snapshotValue = {
      identity: sourceRevisionIdentity(state.snapshot),
      snapshot: snapshotIdentity,
      executionGrant: state.executionGrant,
      workflowCheckpoint: state.workflowCheckpoint,
      planApproval: state.planApproval,
      reconciliationTransaction: state.reconciliationTransaction,
    };
    const reviewValue = {
      corrections: state.corrections,
      findings: state.findings,
      manualEdits: state.manualEdits,
      executionEvidence: state.executionEvidence,
      focusedValidationSelections: state.focusedValidationSelections,
    };
    const workingStateValue = {
      mode: state.mode,
      planObjective: state.planObjective,
      taskSelection: state.taskSelection,
      nextAction: state.nextAction,
      taskClosure: state.taskClosure,
      workflowCheckpoint: state.workflowCheckpoint,
      omissions: state.omissions,
      // State IDs and build timestamps are observation metadata, not source changes.
      markdown: this.workingStateBuilder.toMarkdown(state)
        .replace(`- Working state: ${state.stateId}`, "- Working state: [current]")
        .replace(/ \/ dirty generation \d+/, " / dirty generation [current]"),
    };
    const validationDigest = sourcePathFingerprint(this.config.repositoryRoot, this.config.validationPath);
    const validationAvailable = existsSync(this.config.validationPath);
    let validationFreshness: ContextCapsuleSource["freshness"] = validationAvailable ? "current" : "unavailable";
    let configuredGateInventory: { configured: Record<string, unknown>; closurePolicy: unknown } | undefined;
    if (options.gateInventory === undefined) {
      try {
        const manifest = this.validation.manifest();
        configuredGateInventory = {
          configured: manifest.validations,
          closurePolicy: manifest.closurePolicy,
        };
      } catch (error) {
        omissions.push(`Quality-gate inventory was unavailable: ${error instanceof Error ? error.message : String(error)}`);
        configuredGateInventory = { configured: {}, closurePolicy: {} };
        validationFreshness = "unavailable";
      }
    }
    const qualityGateValue = options.gateInventory ?? {
      ...(configuredGateInventory ?? {}),
      current: state.currentValidationEvidence,
      stale: state.staleValidationEvidence,
      closure: state.taskClosure,
    };
    const validationSource: ContextCapsuleSource = {
      id: "atelier:quality-gates",
      kind: "quality-gate-inventory",
      digest: sha256(stableJson({ manifest: validationDigest, inventory: qualityGateValue })),
      location: repositoryRelativePath(this.config.repositoryRoot, this.config.validationPath, "read"),
      boundary: "validation manifest and current validation evidence",
      freshness: validationFreshness,
    };
    const taskSource: ContextCapsuleSource = {
      id: `task-provider:${this.taskProvider.name}`,
      kind: "beads",
      digest: sha256(stableJson(taskValue)),
      location: state.activeTask?.id ?? "ready-task-set",
      boundary: "selected task, direct dependencies, and bounded ready set",
      freshness: "current",
    };
    const retrievalSource: ContextCapsuleSource = {
      id: `retrieval:${state.retrievalSession?.id ?? "none"}`,
      kind: "code-intelligence",
      digest: sha256(stableJson(retrievalValue)),
      location: state.retrievalSession?.id ?? "no retrieval session",
      boundary: "scoped evidence, queries, inventory, and provider decisions",
      freshness: state.retrievalSession === undefined
        ? "unavailable"
        : state.retrievalSession.freshness === "current"
          ? "current"
          : state.retrievalSession.freshness === "possibly_stale"
            ? "stale"
            : "unknown",
    };
    const snapshotSource: ContextCapsuleSource = {
      id: `snapshot:${state.snapshot.repositoryId}`,
      kind: "repository-snapshot",
      digest: sha256(stableJson(snapshotValue)),
      location: state.snapshot.repositoryId,
      boundary: sourceRevisionIdentity(state.snapshot),
      freshness: "current",
    };
    const reviewSource: ContextCapsuleSource = {
      id: `ledger:task:${state.activeTask?.id ?? "none"}`,
      kind: "ledger-review",
      digest: sha256(stableJson(reviewValue)),
      location: state.activeTask?.id ?? "workflow ledger",
      boundary: "bounded findings, corrections, edits, and execution evidence",
      freshness: "current",
    };
    const workingStateSource: ContextCapsuleSource = {
      id: "working-state:current",
      kind: "working-state",
      digest: sha256(stableJson(workingStateValue)),
      location: "current Core Working State",
      boundary: "one Core Working State build",
      freshness: "current",
    };
    const sections: ContextCapsuleSectionInput[] = [
      { name: "task", kind: "beads", sources: [taskSource], value: taskValue, budgetClass: "items" },
      { name: "working_state", kind: "working-state", sources: [workingStateSource], value: workingStateValue },
      { name: "snapshot", kind: "repository-snapshot", sources: [snapshotSource], value: snapshotValue },
      { name: "code", kind: "code-intelligence", sources: [retrievalSource], value: retrievalValue, budgetClass: "retrieval" },
      { name: "reviews", kind: "ledger-review", sources: [reviewSource], value: reviewValue, budgetClass: "history" },
      { name: "quality_gates", kind: "quality-gate-inventory", sources: [validationSource], value: qualityGateValue, budgetClass: "history" },
    ];
    if (documentSources.length > 0) {
      sections.push({
        name: "documents",
        kind: "design-and-implementation-records",
        sources: documentSources,
        value: documentValues,
        budgetClass: "items",
      });
    }

    const boundary = {
      repository: this.config.repositoryRoot,
      taskId: state.activeTask?.id ?? options.explicitTaskId ?? "none",
      executionGrant: state.executionGrant,
      approvedPlanHash: state.approvedPlanHash,
      sourceDigests: sections.map((section) => ({ name: section.name, sources: section.sources.map((source) => source.digest) })),
      snapshot: snapshotValue,
      documentPaths: documentSources.map((source) => source.location),
      budgets: options.budgets ?? {},
    };
    const cacheKey = preflightKey ?? contextBoundaryDigest(boundary);
    return this.contextCapsuleCache.getOrBuild(cacheKey, () => buildContextCapsule({
      boundary,
      sections,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      omissions,
    }));
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
      if (previousGrant.executionSource === "standalone") {
        return `Reactivate standalone task ${previousGrant.taskId} with its explicit task scope.`;
      }
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
      securityMode: this.config.securityMode,
      sandboxBackend: this.config.sandboxBackend,
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
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async () => {
      try {
        await this.code.close();
      } finally {
        this.ledger.close();
      }
    })();
    return this.closePromise;
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
    const decision = this.config.securityMode === "core-only"
      ? coreOnlyWorkspaceDecision(effects)
      : this.workspacePolicy.evaluate(effects, {
          classify: (path) => observation.pathStates[path]
            ?? this.repository.classifyPath?.(path)
            ?? (existsSync(path) ? "untracked" : "missing"),
        });
    return { decision, observation };
  }

  evaluateWorkspaceEffects(effects: readonly FilesystemEffect[]): WorkspacePolicyDecision {
    return this.config.securityMode === "core-only"
      ? coreOnlyWorkspaceDecision(effects)
      : this.workspacePolicy.evaluate(effects, { classify: (path) => this.repository.classifyPath?.(path) ?? (existsSync(path) ? "untracked" : "missing") });
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
      {
        ...options,
        ...(this.ledger.getActiveExecutionGrant()?.executionBaseline === undefined
          ? {}
          : { baseline: this.ledger.getActiveExecutionGrant()!.executionBaseline }),
      },
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
    const checkpoint = this.recovery.get(id);
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant !== undefined && checkpoint.baseline !== undefined
      && checkpoint.baseline.digest !== grant.executionBaseline?.digest) {
      throw new Error(`Recovery checkpoint ${id} belongs to a different execution baseline.`);
    }
    if (grant !== undefined) {
      this.execution.pause(`Recovery checkpoint ${id} restored; explicit resume is required.`, { checkpointId: id });
    }
    const paths = this.recovery.restore(id);
    this.ledger.append({
      kind: "recovery.checkpoint_restored",
      actor: "user",
      repositorySnapshot: this.repository.snapshot(),
      payload: {
        id,
        paths,
        ...(checkpoint.baseline === undefined ? {} : { baselineDigest: executionBaselineDigest(checkpoint.baseline) }),
      },
    });
    return paths;
  }
}

function coreOnlyWorkspaceDecision(effects: readonly FilesystemEffect[]): WorkspacePolicyDecision {
  const reason = "Workspace permission enforcement is disabled in core-only mode.";
  return {
    result: "allow",
    effects: effects.map((effect) => ({
      ...effect,
      state: "unknown" as const,
      decision: "allow" as const,
      reason,
    })),
    reason,
  };
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
    environment: {
      OCTOCODE_CONFIG_PATH: config.octocodeConfigPath,
      ...octocodeCredentialEnvironment(),
    },
  });
  return {
    providers: [codesearch, octocode],
    defaultProvider: config.codeProvider,
  };
}
