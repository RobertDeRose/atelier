import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createStatusView,
  sourceRevisionIdentity,
  statusViewSummary,
  type AtelierCore,
  type CodeIndexCoordinatorStatus,
  type CodeProviderStatus,
  type CodeWorkspace,
  type AtelierStatus,
} from "../../../packages/core/src/index.ts";
import { installAtelierFooter, renderAtelierFooter, type FooterIntelState } from "./status-presentation.ts";
import { recordFooterEvidence } from "./ui-evidence.ts";

const STATUS_KEY = "atlr";
const OBSERVATION_REUSE_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerIntelState(status: CodeProviderStatus): FooterIntelState {
  if (!status.available || !status.healthy || status.indexState === "failed") return "offline";
  if (status.indexState === "building") return "indexing";
  if (status.degraded === true || status.indexState === "stale") return "degraded";
  if (status.indexState === "ready") return "ready";
  return "offline";
}

/** Owns the live, session-local data and serialized refreshes for Atelier's custom Pi footer. */
export class FooterStatusController {
  private thinkingLevel?: string;
  private modelName?: string;
  private providerIntel?: FooterIntelState;
  private indexedWorkspaceSourceDigest?: string;
  private lastIndexCompletionKey?: string;
  private enabled = true;
  private refreshPromise?: Promise<void>;
  private requestedGeneration = 0;
  private completedGeneration = 0;
  private readonly refreshWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private pendingContext?: ExtensionContext;
  private pendingCore?: AtelierCore;
  private pendingStatus?: AtelierStatus;
  private lastContext?: ExtensionContext;
  private lastCore?: AtelierCore;
  private lastStatus?: AtelierStatus;
  /** Last complete repository/provider observation; optimistic workflow renders never replace it. */
  private lastObservedStatus?: AtelierStatus;
  /** Last authoritative state before a pause, used for immediate resume rendering. */
  private lastUnpausedStatus?: AtelierStatus;
  private lastIntel?: FooterIntelState;
  private lastObservedAt = 0;
  private lastFooterEvidenceKey?: string;

  setRuntime(options: { thinkingLevel?: string; modelName?: string }): void {
    if (options.thinkingLevel !== undefined) this.thinkingLevel = options.thinkingLevel;
    if (options.modelName !== undefined) this.modelName = options.modelName;
  }

  enable(): void {
    this.enabled = true;
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.refreshPromise?.catch(() => {});
    for (const waiter of this.refreshWaiters.splice(0)) waiter.resolve();
    delete this.pendingContext;
    delete this.pendingCore;
    delete this.pendingStatus;
    delete this.lastContext;
    delete this.lastCore;
    delete this.lastStatus;
    delete this.lastObservedStatus;
    delete this.lastUnpausedStatus;
    delete this.lastIntel;
    this.lastObservedAt = 0;
    delete this.lastFooterEvidenceKey;
  }

  resetRepository(): void {
    delete this.providerIntel;
    delete this.lastObservedStatus;
    delete this.lastUnpausedStatus;
    delete this.lastFooterEvidenceKey;
    delete this.indexedWorkspaceSourceDigest;
    delete this.lastIndexCompletionKey;
  }

  markProviderOffline(): void {
    this.providerIntel = "offline";
  }

  recordWorkspaceIndexed(workspace: CodeWorkspace): void {
    this.indexedWorkspaceSourceDigest = workspace.repositories
      .map((repository) => `${repository.id}:${sourceRevisionIdentity(repository.snapshot)}`)
      .sort()
      .join("\n");
    this.providerIntel = "ready";
  }

  recordProvider(core: AtelierCore, status: CodeProviderStatus): void {
    this.providerIntel = providerIntelState(status);
    const current = this.lastStatus;
    if (current !== undefined && status.indexedRevisions !== undefined) {
      const indexed = status.indexedRevisions[current.snapshot.repositoryId];
      if (indexed !== undefined) {
        this.indexedWorkspaceSourceDigest = `${current.snapshot.repositoryId}:${indexed}`;
      }
    }
    // Keep the parameter for call-site compatibility and to make the ownership
    // explicit; provider readiness itself is cached by the code service.
    void core;
  }

  recordIndex(core: AtelierCore, indexing: CodeIndexCoordinatorStatus): void {
    if (indexing.active || indexing.state === "building") {
      this.providerIntel = "indexing";
      return;
    }
    if (indexing.state === "failed") {
      this.providerIntel = "offline";
      return;
    }
    if (indexing.state !== "ready") return;

    const completionKey = [
      indexing.provider ?? "provider",
      indexing.workspaceId ?? "workspace",
      indexing.completedAt ?? indexing.startedAt ?? "ready",
    ].join(":");
    if (this.lastIndexCompletionKey === completionKey) return;

    // A newly completed coordinator operation indexed the source snapshot that
    // was current at completion. Provider status can later replace this with a
    // more precise provider-reported indexed-revision binding.
    this.lastIndexCompletionKey = completionKey;
    if (this.lastStatus !== undefined) {
      this.indexedWorkspaceSourceDigest = this.lastStatus.workspaceSourceDigest;
    }
    this.providerIntel = "ready";
    void core;
  }

  refresh(ctx: ExtensionContext, core: AtelierCore, status?: AtelierStatus): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.pendingContext = ctx;
    this.pendingCore = core;
    if (status === undefined) delete this.pendingStatus;
    else this.pendingStatus = status;
    const generation = ++this.requestedGeneration;
    const completion = new Promise<void>((resolve, reject) => {
      this.refreshWaiters.push({ generation, resolve, reject });
    });
    this.ensureRefreshDrain();
    return completion;
  }

  private ensureRefreshDrain(): void {
    if (!this.enabled || this.refreshPromise !== undefined) return;
    this.refreshPromise = this.drainRefreshes()
      .catch((error) => {
        for (const waiter of this.refreshWaiters.splice(0)) waiter.reject(error);
      })
      .finally(() => {
        delete this.refreshPromise;
        // A request can arrive after the drain's final loop check but before
        // this finally callback. Start another drain rather than losing that
        // request or resolving its caller before the footer was rendered.
        if (this.enabled && this.completedGeneration < this.requestedGeneration) {
          this.ensureRefreshDrain();
        }
      });
  }

  private async drainRefreshes(): Promise<void> {
    while (this.enabled && this.completedGeneration < this.requestedGeneration) {
      const targetGeneration = this.requestedGeneration;
      const currentContext = this.pendingContext;
      const currentCore = this.pendingCore;
      const currentStatus = this.pendingStatus;
      delete this.pendingStatus;
      if (currentContext !== undefined && currentCore !== undefined) {
        await this.refreshNow(currentContext, currentCore, currentStatus);
      }
      this.completedGeneration = targetGeneration;
      for (let index = this.refreshWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.refreshWaiters[index]!;
        if (waiter.generation > targetGeneration) continue;
        this.refreshWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private effectiveIntelState(core: AtelierCore, status: AtelierStatus): FooterIntelState {
    if (core.config.codeProvider === "disabled") return "disabled";
    const indexing = core.code.indexingStatus();
    const currentSourceDigest = status.workspaceSourceDigest;

    if (indexing.active || indexing.state === "building" || this.providerIntel === "indexing") {
      return "indexing";
    }
    if (indexing.state === "failed" || this.providerIntel === "offline") return "offline";
    if (
      this.indexedWorkspaceSourceDigest !== undefined
      && this.indexedWorkspaceSourceDigest !== currentSourceDigest
    ) return "degraded";
    if (this.providerIntel === "degraded" || indexing.state === "stale") return "degraded";
    if (this.providerIntel === "ready" || indexing.state === "ready") return "ready";
    return "offline";
  }

  /**
   * Render a ledger-only workflow transition immediately, without waiting for
   * repository, task-provider, or code-intelligence observation. A normal
   * asynchronous refresh can replace this optimistic view afterward.
   */
  renderWorkflowTransition(ctx: ExtensionContext, core: AtelierCore): void {
    if (!this.enabled || this.lastStatus === undefined || this.lastCore !== core) return;

    const grant = core.ledger.getActiveExecutionGrant();
    const currentTaskId = core.ledger.getState<string>("currentTaskId");
    const workflowCheckpoint = core.currentWorkflowRun()?.checkpoint ?? "none";
    const paused = workflowCheckpoint === "paused";
    const observed = paused
      ? this.lastObservedStatus ?? this.lastStatus
      : this.lastUnpausedStatus ?? this.lastObservedStatus ?? this.lastStatus;
    const {
      activeExecutionGrant: _previousGrant,
      currentTaskId: previousTaskId,
      currentTaskTitle: previousTaskTitle,
      ...base
    } = observed;
    const resumedFromPausedObservation = !paused && grant !== undefined
      && (base.closureStatus.includes("execution is paused") || /Resume execution/i.test(base.nextAction));
    const status: AtelierStatus = {
      ...base,
      mode: core.mode(),
      workflowCheckpoint,
      activeTaskConstraints: core.activeTaskConstraints(),
      closureStatus: grant === undefined
        ? workflowCheckpoint === "completed" ? "completed" : "not applicable — no active task"
        : paused
          ? "blocked — execution is paused"
          : resumedFromPausedObservation
            ? "pending — evaluating completion readiness"
            : base.closureStatus,
      nextAction: grant === undefined
        ? workflowCheckpoint === "cancelled"
          ? "Resume the cancelled approved task or start a new plan."
          : base.nextAction
        : paused
          ? `Resume execution ${grant.id} before mutating task state.`
          : resumedFromPausedObservation
            ? `Continue execution for task ${grant.taskId}.`
            : base.nextAction,
      ...(grant === undefined ? {} : { activeExecutionGrant: grant }),
      ...(currentTaskId === undefined ? {} : { currentTaskId }),
      ...(currentTaskId !== undefined && currentTaskId === previousTaskId && previousTaskTitle !== undefined
        ? { currentTaskTitle: previousTaskTitle }
        : {}),
    };

    this.lastContext = ctx;
    this.lastStatus = status;
    if (!paused) this.lastUnpausedStatus = status;
    const intel = this.lastIntel ?? this.effectiveIntelState(core, status);
    this.lastIntel = intel;
    this.render(ctx, core, status, intel);
  }

  /** Re-render only model/thinking/context fields without repository or provider I/O. */
  renderRuntime(ctx = this.lastContext): void {
    if (!this.enabled || ctx === undefined || this.lastCore === undefined || this.lastStatus === undefined) return;
    this.render(ctx, this.lastCore, this.lastStatus, this.lastIntel ?? this.effectiveIntelState(this.lastCore, this.lastStatus));
  }


  private render(ctx: ExtensionContext, core: AtelierCore, status: AtelierStatus, intel: FooterIntelState): void {
    const indexing = core.code.indexingStatus();
    const index = intel === "indexing" ? "indexing…" : `index ${indexing.state}`;
    const value = `${statusViewSummary(createStatusView(status))} · ${index}`;
    if (core.config.footer === "disabled") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setFooter?.(undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, value);
    installAtelierFooter(ctx, status, intel, this.thinkingLevel, core.config.footer, this.modelName);

    const evidenceWidth = 120;
    const lines = renderAtelierFooter(
      ctx,
      status,
      intel,
      evidenceWidth,
      {},
      this.thinkingLevel,
      this.modelName,
    ).map((line) => line.trimEnd());
    const contextPercent = ctx.getContextUsage?.()?.percent;
    const model = this.modelName ?? ctx.model?.id ?? ctx.model?.name;
    const evidenceKey = JSON.stringify({
      lines,
      model,
      thinkingLevel: this.thinkingLevel,
      contextPercent,
      mode: status.mode,
      taskId: status.currentTaskId,
      vcs: status.repositoryDisplay.vcs,
      vcsState: status.repositoryDisplay.state,
      intel,
    });
    if (evidenceKey !== this.lastFooterEvidenceKey) {
      this.lastFooterEvidenceKey = evidenceKey;
      recordFooterEvidence(core, {
        lines,
        width: evidenceWidth,
        ...(model === undefined ? {} : { model }),
        ...(this.thinkingLevel === undefined ? {} : { thinkingLevel: this.thinkingLevel }),
        ...(contextPercent === undefined ? {} : { contextPercent }),
        mode: status.mode,
        ...(status.currentTaskId === undefined ? {} : { taskId: status.currentTaskId }),
        vcs: status.repositoryDisplay.vcs,
        vcsState: status.repositoryDisplay.state,
        intel,
      });
    }
  }

  private async refreshNow(ctx: ExtensionContext, core: AtelierCore, suppliedStatus?: AtelierStatus): Promise<void> {
    if (!this.enabled) return;
    try {
      const reusable = suppliedStatus === undefined
        && this.lastCore === core
        && this.lastStatus !== undefined
        && core.repository.peekObservation?.() !== undefined
        && Date.now() - this.lastObservedAt <= OBSERVATION_REUSE_MS;
      const status = suppliedStatus
        ?? (reusable ? this.lastStatus! : await core.status());
      if (!reusable || suppliedStatus !== undefined) this.lastObservedAt = Date.now();
      const intel = this.effectiveIntelState(core, status);
      this.lastContext = ctx;
      this.lastCore = core;
      this.lastStatus = status;
      this.lastObservedStatus = status;
      if (status.workflowCheckpoint !== "paused") this.lastUnpausedStatus = status;
      this.lastIntel = intel;
      this.render(ctx, core, status, intel);
    } catch (error) {
      ctx.ui.setStatus(STATUS_KEY, "Atelier unavailable");
      // A failed observation must not leave a previously valid custom footer
      // displaying stale repository, workflow, or intelligence state.
      ctx.ui.setFooter?.(undefined);
      ctx.ui.notify(errorMessage(error), "error");
    }
  }
}
