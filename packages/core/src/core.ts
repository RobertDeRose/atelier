import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadConfig, type AtelierConfig } from "./config/config.ts";
import { WorkingStateBuilder } from "./state/working-state-builder.ts";
import type {
  ActionRequest,
  ExecutionEvidence,
  ExecutionGrant,
  FinalDiffPreview,
  FinalDiffReview,
  ManualEdit,
  ManualEditEditor,
  WorkingState,
  Permission,
  PermissionGrant,
  PolicyDecision,
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
import { PolicyEngine } from "./policy/policy-engine.ts";
import { ExecutionWorkflowCoordinator } from "./workflow/execution-workflow-coordinator.ts";
import { capabilitiesForPlanTask, sourceBaselineMismatch } from "./workflow/execution-baseline.ts";
import { createRepositoryProvider } from "./repository/repository-factory.ts";
import type { RepositoryCommitResult, RepositoryProvider } from "./repository/repository-provider.ts";
import { sourceSnapshotFingerprint } from "./repository/snapshot.ts";
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
import { hashFile, sha256 } from "./util/hash.ts";
import { newId, nowIso } from "./util/ids.ts";
import { isPathWithin, resolveAccessPath } from "./security/path-boundary.ts";
import { isSourcePath, sourcePaths } from "./repository/source-path.ts";
import { repositoryRevisionBinding, type RepositoryRevisionBinding } from "./repository/revision-binding.ts";
import { WorkspacePolicyEvaluator, type FilesystemEffect, type WorkspacePolicyDecision } from "./policy/workspace-policy.ts";
import { RecoveryManager, type RecoveryCheckpoint } from "./recovery/recovery-manager.ts";

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
  activeExecutionGrant?: ExecutionGrant;
  taskProvider: TaskProviderStatus;
  snapshot: ReturnType<RepositoryProvider["snapshot"]>;
  activePermissions: PermissionGrant[];
  workflowCheckpoint: string;
  closureStatus: string;
  nextAction: string;
}

function repositoryRelativeSourcePath(repositoryRoot: string, path: string): string | undefined {
  const absolute = resolve(path);
  const rel = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || !isSourcePath(rel)) return undefined;
  return rel;
}

function sourcePathFingerprint(repositoryRoot: string, path: string): string {
  const absolute = resolve(repositoryRoot, path);
  if (!existsSync(absolute)) return "missing";
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return `non-file:${stat.mode}:${stat.size}`;
    return `file:${stat.size}:${sha256(readFileSync(absolute))}`;
  } catch {
    return "unreadable";
  }
}

function pathFingerprintMap(repositoryRoot: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, sourcePathFingerprint(repositoryRoot, path)]));
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
  readonly execution: ExecutionWorkflowCoordinator;
  readonly workspacePolicy: WorkspacePolicyEvaluator;
  readonly recovery: RecoveryManager;

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
    this.recovery = new RecoveryManager({ workspaceRoot: config.workspaceRoot, runtimeDirectory: config.runtimeDirectory, maxBytes: config.checkpointMaxBytes });
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
      trusted: true,
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
      repositoryBindings: () => this.repositoryRevisionBindings(),
      retrievalBindings: () => this.code.retrievalStatus().bindings,
      validationCapabilities: () => Object.entries(this.validation.manifest().validations)
        .map(([name, definition]) => ({
          name,
          category: definition.category === "full" ? "full" as const : "focused" as const,
          required: definition.required === true,
        })),
      validationRequired: () => this.validation.closurePolicy().requireValidation,
      repositoryRoots: () => Object.fromEntries(this.codeWorkspace().repositories.map((repository) => [repository.id, repository.root])),
      primaryRepositoryId: () => this.codeWorkspace().repositories.find((repository) => repository.root === this.config.repositoryRoot)?.id ?? this.repository.snapshot().repositoryId,
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

  initialize(options: { createPlan?: boolean } = {}): { createdPlan: boolean } {
    mkdirSync(this.config.projectDirectory, { recursive: true });
    mkdirSync(this.config.runtimeDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.config.projectConfigPath)) {
      writeFileSync(
        this.config.projectConfigPath,
        `${JSON.stringify(
          {
            planPath: relative(this.config.repositoryRoot, this.config.planPath),
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

  evaluate(request: ActionRequest): PolicyDecision {
    const decision = this.policy.evaluate(request, {
      mode: this.mode(),
      repositoryRoot: this.config.workspaceRoot,
      repositoryReadRoots: [this.config.workspaceRoot],
      planPath: this.config.planPath,
      grants: this.ledger.listGrants(),
      ...(this.ledger.getActiveExecutionGrant() === undefined
        ? {}
        : {
            executionGrant: this.ledger.getActiveExecutionGrant()!,
            executionPaused: this.execution.isPaused(),
          }),
      ...(request.action === "task.close" ? { taskClosure: this.taskClosureReadiness() } : {}),
    });
    this.ledger.append({
      kind: "policy.decision",
      actor: request.actor,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.repositorySnapshot === undefined ? {} : { repositorySnapshot: request.repositorySnapshot }),
      payload: decision,
    });
    if (decision.result === "allow") {
      const matched = decision.matchedRules.find((rule) => rule.startsWith("matched permission grant "));
      const grantId = matched?.slice("matched permission grant ".length);
      const grant = grantId === undefined ? undefined : this.ledger.listGrants().find((item) => item.id === grantId);
      if (grant?.scope === "operation" && this.ledger.revokeGrant(grant.id)) {
        this.ledger.append({
          kind: "permission.consumed",
          actor: "system",
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          payload: { grantId: grant.id, executionGrantId: grant.executionGrantId, decisionId: decision.id },
        });
      }
    }
    return decision;
  }

  grant(options: {
    permission: Permission;
    scope?: PermissionGrant["scope"];
    actor?: PermissionGrant["actor"];
    taskId?: string;
    paths?: string[];
    validationNames?: string[];
    reason: string;
    expiresAt?: string;
  }): PermissionGrant {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    const scope = options.scope ?? "operation";
    const taskId = options.taskId ?? (scope === "task" ? executionGrant?.taskId : undefined);
    if (scope === "task" && (executionGrant === undefined || taskId !== executionGrant.taskId)) {
      throw new Error("Task-scoped grants require the active execution task.");
    }
    const access = options.permission === "repository.read" ? "read" : "write";
    const paths = options.paths?.map((path) => resolveAccessPath(path, access, this.config.repositoryRoot));
    const snapshot = this.repository.snapshot();
    const grant: PermissionGrant = {
      id: newId("grant"),
      ...(executionGrant !== undefined && (taskId === undefined || taskId === executionGrant.taskId)
        ? { executionGrantId: executionGrant.id }
        : {}),
      permission: options.permission,
      scope,
      actor: options.actor ?? "user",
      ...(taskId === undefined ? {} : { taskId }),
      repositoryId: snapshot.repositoryId,
      ...(paths === undefined ? {} : { paths }),
      ...(options.validationNames === undefined ? {} : { validationNames: [...options.validationNames] }),
      reason: options.reason,
      createdAt: nowIso(),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    };
    this.ledger.saveGrant(grant);
    this.ledger.append({
      kind: "permission.granted",
      actor: "user",
      ...(taskId === undefined ? {} : { taskId }),
      repositorySnapshot: snapshot,
      payload: grant,
    });
    return grant;
  }

  beginExecutionEvidence(input: {
    toolCallId: string;
    toolName: string;
    request: ActionRequest;
    policyDecisionId: string;
    permissionGrantId?: string;
  }): ExecutionEvidence {
    if (input.request.action === "read.repository") throw new Error("Read-only tools do not create mutation execution evidence.");
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined || input.request.taskId !== executionGrant.taskId) {
      throw new Error("Mutation execution evidence requires the active task execution grant.");
    }
    const decisionEvent = this.ledger.listEvents({ kind: "policy.decision", limit: 100 })
      .find((event) => (event.payload as PolicyDecision).id === input.policyDecisionId);
    const decision = decisionEvent?.payload as PolicyDecision | undefined;
    const authorizedSnapshot = decisionEvent?.repositorySnapshot;
    const currentSnapshot = this.repository.snapshot();
    if (decision === undefined || decision.result !== "allow" || decision.action !== input.request.action
      || decisionEvent?.taskId !== executionGrant.taskId
      || authorizedSnapshot === undefined
      || sourceBaselineMismatch(authorizedSnapshot, currentSnapshot) !== undefined) {
      throw new Error("Mutation execution evidence requires a current matching allow policy decision.");
    }
    const matchedPermissionGrantId = decision.matchedRules
      .find((rule) => rule.startsWith("matched permission grant "))
      ?.slice("matched permission grant ".length);
    const concreteWorkspaceApproval = decision.matchedRules.includes("matched concrete workspace-policy approval");
    if (!concreteWorkspaceApproval) {
      if (matchedPermissionGrantId === undefined
        || (input.permissionGrantId !== undefined && input.permissionGrantId !== matchedPermissionGrantId)) {
        throw new Error("Mutation execution evidence requires the task authority matched by policy.");
      }
      const permissionGrant = this.ledger.listGrants({ includeRevoked: true })
        .find((grant) => grant.id === matchedPermissionGrantId);
      if (permissionGrant?.executionGrantId !== executionGrant.id) {
        throw new Error("Mutation execution evidence authority is not bound to the active execution grant.");
      }
    }
    const evidence: ExecutionEvidence = {
      id: newId("execution-evidence"),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      action: input.request.action,
      status: "started",
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      policyDecisionId: input.policyDecisionId,
      ...(matchedPermissionGrantId === undefined ? {} : { permissionGrantId: matchedPermissionGrantId }),
      beforeSnapshot: currentSnapshot,
      requestedPaths: sourcePaths((input.request.paths ?? [])
        .flatMap((path) => repositoryRelativeSourcePath(this.config.repositoryRoot, path) ?? [])),
      beforeChangedPaths: input.request.action === "task.close"
        ? this.repository.rawChangedPaths()
        : sourcePaths(this.repository.changedPaths()),
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
    let changedPaths: string[];
    try {
      changedPaths = executionGrant.repositorySnapshot.vcs === "none"
        ? sourcePaths(this.repository.changedPaths())
        : sourcePaths(this.repository.changedPathsFrom(
            executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit,
          ));
    } catch {
      changedPaths = sourcePaths(this.repository.changedPaths());
    }
    this.ledger.setWorkflowCheckpoint("validating");
    const selection = this.validation.saveFocusedSelection({
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      planHash: executionGrant.planHash,
      reconciliationDigest: executionGrant.reconciliationDigest,
      snapshot: this.repository.snapshot(),
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
    const snapshot = this.repository.snapshot();
    if (executionGrant !== undefined) {
      const action = this.validation.action(name);
      const decision = this.evaluate({
        action,
        risk: "routine",
        actor: "agent",
        taskId: executionGrant.taskId,
        repositorySnapshot: snapshot,
        validationName: name,
        boundary: "typed",
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

  activeExecutionCapabilities() {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) return [];
    const approval = this.ledger.getPlanApproval(grant.planApprovalId);
    return approval === undefined ? [] : capabilitiesForPlanTask(approval.capabilities, grant.planTaskId);
  }

  approvedTaskPaths(): string[] {
    return [...new Set(this.activeExecutionCapabilities()
      .filter((capability) => capability.permission === "file.write" || capability.permission === "dependency.modify")
      .flatMap((capability) => capability.paths ?? []))].sort();
  }

  approvedValidationNames(category: "focused" | "full"): string[] {
    const permission = category === "focused" ? "validation.focused" : "validation.full_suite";
    return [...new Set(this.activeExecutionCapabilities()
      .filter((capability) => capability.permission === permission)
      .flatMap((capability) => capability.validationNames ?? []))].sort();
  }

  private approvedChangedPaths(fromBaseline = false): string[] {
    const grant = this.ledger.getActiveExecutionGrant();
    if (grant === undefined) throw new Error("Approved task paths require an active execution grant.");
    const base = grant.repositorySnapshot.sourceBaseCommit ?? grant.repositorySnapshot.headCommit;
    const changed = sourcePaths(fromBaseline
      ? this.repository.changedPathsFrom(base)
      : this.repository.changedPaths());
    const allowed = this.approvedTaskPaths();
    const outside = changed.filter((path) => {
      const absolute = resolve(this.config.repositoryRoot, path);
      return !allowed.some((root) => isPathWithin(absolute, root, "write"));
    });
    if (outside.length > 0) {
      throw new Error(`Source changes exceed the reviewed task scope: ${outside.join(", ")}.`);
    }
    return changed;
  }

  currentFinalDiffReview(): FinalDiffReview | undefined {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) return undefined;
    return this.ledger.getState<FinalDiffReview>(`finalDiffReview:${executionGrant.id}`);
  }

  previewFinalDiff(): FinalDiffPreview {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("Final diff review requires an active execution grant.");
    if (executionGrant.repositorySnapshot.vcs === "none") {
      throw new Error("Final diff review requires a revision-aware repository baseline.");
    }
    const baseline = executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit;
    const changedPaths = this.approvedChangedPaths(true);
    const diff = changedPaths.map((path) => this.repository.diffFrom(baseline, path)).filter((item) => item.trim()).join("\n");
    if (!diff.trim()) throw new Error("No approved task diff exists relative to the reviewed source baseline.");
    return {
      taskId: executionGrant.taskId,
      executionGrantId: executionGrant.id,
      baselineHeadCommit: baseline,
      changedPaths,
      diff,
      diffHash: sha256(diff),
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

  commitActiveTask(message: string, actor: "user" | "agent" = "user"): RepositoryCommitResult {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("A local task change requires an active execution grant.");
    const snapshot = this.repository.snapshot();
    const changedPaths = this.approvedChangedPaths(false);
    if (changedPaths.length === 0) throw new Error("No approved source changes are available to commit.");
    const absolutePaths = changedPaths.map((path) => resolve(this.config.repositoryRoot, path));
    const decision = this.evaluate({
      action: "repository.change.create",
      risk: "routine",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      paths: absolutePaths,
      boundary: "typed",
      rationale: "Create the local repository change required by the approved task.",
    });
    if (decision.result !== "allow") throw new Error(decision.reason);
    const result = this.repository.commit(message, changedPaths);
    this.ledger.append({
      kind: "repository.change_created",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: result.snapshot,
      payload: {
        message: result.message,
        changedPaths: result.changedPaths,
        baselineHeadCommit: executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit,
      },
    });
    return result;
  }

  taskClosureReadiness(): TaskClosureReadiness {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) {
      const completed = this.currentWorkflowRun()?.checkpoint === "completed";
      return {
        ready: completed,
        blockers: [], required: [], missing: [], stale: [], failed: [],
        reason: completed
          ? "The approved task is complete and its execution grant was revoked."
          : "No active task exists.",
      };
    }
    const snapshot = this.repository.snapshot();
    const validation = this.validation.closureReadiness(snapshot, executionGrant.taskId, executionGrant.id);
    const policy = this.validation.closurePolicy();
    const review = this.currentFinalDiffReview();
    let diffHash: string | undefined;
    try {
      if (executionGrant.repositorySnapshot.vcs !== "none") {
        const baseline = executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit;
        const paths = this.approvedChangedPaths(true);
        diffHash = sha256(paths.map((path) => this.repository.diffFrom(baseline, path)).filter((item) => item.trim()).join("\n"));
      }
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
    const localChangeCreated = !policy.requireLocalChange
      || (snapshot.vcs !== "none"
        && snapshot.headCommit !== "unborn"
        && (snapshot.sourceBaseCommit ?? snapshot.headCommit)
          !== (executionGrant.repositorySnapshot.sourceBaseCommit ?? executionGrant.repositorySnapshot.headCommit));
    let sourceStateAcceptable = true;
    let repositoryMetadataPaths: string[] = [];
    try {
      sourceStateAcceptable = !policy.requireCleanSource || this.repository.changedPaths().length === 0;
      repositoryMetadataPaths = this.repository.rawChangedPaths().filter((path) => !isSourcePath(path));
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
    return {
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
  }

  async closeActiveTask(reason: string, actor: "user" | "agent" = "user"): Promise<{ task: TaskRecord; nextReady: TaskRecord[] }> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant === undefined) throw new Error("No active execution task is available to close.");
    const snapshot = this.repository.snapshot();
    const decision = this.evaluate({
      action: "task.close",
      risk: "routine",
      actor,
      taskId: executionGrant.taskId,
      repositorySnapshot: snapshot,
      boundary: "typed",
      rationale: reason,
    });
    if (decision.result !== "allow") throw new Error(decision.reason);

    // Preserve the exact evidence snapshot that authorized closure. Repository
    // and provider finalization may legitimately change raw VCS state after this
    // point, but must never rewrite the decision that allowed the task to close.
    const closureDecision = this.taskClosureReadiness();
    if (!closureDecision.ready) throw new Error(closureDecision.reason);

    const beforeProviderPaths = this.repository.rawChangedPaths();
    const beforeProviderFingerprints = pathFingerprintMap(this.config.repositoryRoot, beforeProviderPaths);
    const task = await this.taskProvider.close(executionGrant.taskId, reason);
    const afterProviderPaths = this.repository.rawChangedPaths();
    const providerCandidates = [...new Set([...beforeProviderPaths, ...afterProviderPaths])].sort();
    const afterProviderFingerprints = pathFingerprintMap(this.config.repositoryRoot, providerCandidates);
    const providerMutationPaths = providerCandidates.filter((path) =>
      beforeProviderFingerprints[path] !== afterProviderFingerprints[path]
      || beforeProviderPaths.includes(path) !== afterProviderPaths.includes(path));

    const policy = this.validation.closurePolicy();
    let metadataChange: RepositoryCommitResult | undefined;
    if (policy.requireCleanRepository) {
      const metadataPaths = this.repository.rawChangedPaths().filter((path) => !isSourcePath(path));
      if (metadataPaths.length > 0) {
        metadataChange = this.repository.commitMetadata(`chore(atelier): finalize workflow for ${task.id}`, metadataPaths);
      }
      const remaining = this.repository.rawChangedPaths();
      if (remaining.length > 0) {
        throw new Error(`Task provider closed ${task.id}, but repository finalization left tracked changes: ${remaining.join(", ")}`);
      }
    }
    const closedSnapshot = this.repository.snapshot();
    const workflowFinalizationPaths = metadataChange?.changedPaths ?? [];
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
          repositoryClean: this.repository.rawChangedPaths().length === 0,
          sourceFingerprintBefore: sourceSnapshotFingerprint(snapshot),
          sourceFingerprintAfter: sourceSnapshotFingerprint(closedSnapshot),
        },
        ...(metadataChange === undefined ? {} : {
          metadataChange: {
            message: metadataChange.message,
            changedPaths: metadataChange.changedPaths,
          },
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
    this.execution.cancel(`Task ${task.id} was explicitly closed through an authorized typed tool.`, "completed");
    const mappings = new Set(this.ledger.listTaskMappings()
      .filter((mapping) => mapping.provider === this.taskProvider.name && mapping.planHash === executionGrant.planHash)
      .map((mapping) => mapping.providerTaskId));
    return (await this.taskProvider.ready()).filter((candidate) => mappings.has(candidate.id));
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

  codeWorkspace(): CodeWorkspace {
    const snapshot = this.repository.snapshot();
    return loadCodeWorkspace(this.config.repositoryRoot, snapshot, {
      workspacePath: this.config.workspacePath,
      trusted: true,
      rootApproved: (root) => isPathWithin(root, this.config.workspaceRoot, "read"),
      snapshotForRoot: (root) => createRepositoryProvider(this.config, this.ledger, root).snapshot(),
    });
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
    const snapshot = this.repository.snapshot();
    const built = await this.workingStateBuilder.build({
      mode: this.mode(),
      snapshot,
      changedPaths: sourcePaths(this.repository.changedPaths()),
      workspace: this.codeWorkspace(),
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

  async nextAction(): Promise<string> {
    const executionGrant = this.ledger.getActiveExecutionGrant();
    if (executionGrant !== undefined) {
      if (this.execution.isPaused()) return `Execution is paused for task ${executionGrant.taskId}; resume explicitly before agent mutation.`;
      const readiness = this.taskClosureReadiness();
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
    const currentPlanHash = planExists ? hashFile(this.config.planPath) : undefined;
    const activeExecutionGrant = this.ledger.getActiveExecutionGrant();
    const planStatus = !planExists
      ? "missing" as const
      : currentPlanHash !== undefined && approvedPlanHash !== undefined && currentPlanHash === approvedPlanHash
        ? "approved" as const
        : "not_approved" as const;
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
      ...(activeExecutionGrant === undefined ? {} : { activeExecutionGrant }),
      taskProvider,
      snapshot: this.repository.snapshot(),
      activePermissions: this.ledger.listGrants(),
      workflowCheckpoint: this.currentWorkflowRun()?.checkpoint ?? "none",
      closureStatus: activeExecutionGrant === undefined
        ? this.currentWorkflowRun()?.checkpoint === "completed" ? "completed" : "not applicable — no active task"
        : this.taskClosureReadiness().ready ? "ready" : `blocked — ${this.taskClosureReadiness().reason}`,
      nextAction: await this.nextAction(),
    };
  }

  async close(): Promise<void> {
    await this.code.close();
    this.ledger.close();
  }

  evaluateWorkspaceEffects(effects: readonly FilesystemEffect[]): WorkspacePolicyDecision {
    return this.workspacePolicy.evaluate(effects, { classify: (path) => this.repository.classifyPath?.(path) ?? (existsSync(path) ? "untracked" : "missing") });
  }

  checkpointWorkspaceEffects(decision: WorkspacePolicyDecision): RecoveryCheckpoint {
    const checkpoint = this.recovery.checkpoint(decision.effects.filter((effect) => effect.decision === "checkpoint_then_allow"));
    this.ledger.append({ kind: "recovery.checkpoint_created", actor: "system", repositorySnapshot: this.repository.snapshot(), payload: checkpoint });
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
