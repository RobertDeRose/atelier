import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createStatusView,
  sourceRevisionIdentity,
  statusViewSummary,
  type AtelierCore,
  type CodeIndexCoordinatorStatus,
  type CodeProviderStatus,
} from "../../../packages/core/src/index.ts";
import { installAtelierFooter, type FooterIntelState } from "./status-presentation.ts";

const STATUS_KEY = "atlr";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceSourceDigest(core: AtelierCore): string {
  return core.codeWorkspace().repositories
    .map((repository) => `${repository.id}:${sourceRevisionIdentity(repository.snapshot)}`)
    .sort()
    .join("\n");
}

function indexedSourceDigest(
  core: AtelierCore,
  indexedRevisions: Record<string, string> | undefined,
): string | undefined {
  if (indexedRevisions === undefined) return undefined;
  const repositories = core.codeWorkspace().repositories;
  if (repositories.some((repository) => indexedRevisions[repository.id] === undefined)) return undefined;
  return repositories
    .map((repository) => `${repository.id}:${indexedRevisions[repository.id]}`)
    .sort()
    .join("\n");
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
  private refreshRequested = false;
  private enabled = true;
  private refreshPromise?: Promise<void>;
  private pendingContext?: ExtensionContext;
  private pendingCore?: AtelierCore;

  setRuntime(options: { thinkingLevel?: string; modelName?: string }): void {
    if (options.thinkingLevel !== undefined) this.thinkingLevel = options.thinkingLevel;
    if (options.modelName !== undefined) this.modelName = options.modelName;
  }

  enable(): void {
    this.enabled = true;
  }

  async disable(): Promise<void> {
    this.enabled = false;
    this.refreshRequested = false;
    await this.refreshPromise?.catch(() => {});
    delete this.pendingContext;
    delete this.pendingCore;
  }

  resetRepository(): void {
    delete this.providerIntel;
    delete this.indexedWorkspaceSourceDigest;
    delete this.lastIndexCompletionKey;
  }

  markProviderOffline(): void {
    this.providerIntel = "offline";
  }

  recordProvider(core: AtelierCore, status: CodeProviderStatus): void {
    this.providerIntel = providerIntelState(status);
    const indexed = indexedSourceDigest(core, status.indexedRevisions);
    if (indexed !== undefined) this.indexedWorkspaceSourceDigest = indexed;
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
    this.indexedWorkspaceSourceDigest = workspaceSourceDigest(core);
    this.providerIntel = "ready";
  }

  refresh(ctx: ExtensionContext, core: AtelierCore): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.pendingContext = ctx;
    this.pendingCore = core;
    this.refreshRequested = true;
    if (this.refreshPromise !== undefined) return this.refreshPromise;

    this.refreshPromise = (async () => {
      while (this.enabled && this.refreshRequested) {
        this.refreshRequested = false;
        const currentContext = this.pendingContext;
        const currentCore = this.pendingCore;
        if (currentContext !== undefined && currentCore !== undefined) {
          await this.refreshNow(currentContext, currentCore);
        }
      }
    })().finally(() => {
      delete this.refreshPromise;
    });
    return this.refreshPromise;
  }

  private effectiveIntelState(core: AtelierCore): FooterIntelState {
    if (core.config.codeProvider === "disabled") return "disabled";
    const indexing = core.code.indexingStatus();
    const currentSourceDigest = workspaceSourceDigest(core);

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

  private async refreshNow(ctx: ExtensionContext, core: AtelierCore): Promise<void> {
    if (!this.enabled) return;
    try {
      const status = await core.status();
      const indexing = core.code.indexingStatus();
      const intel = this.effectiveIntelState(core);
      const index = intel === "indexing" ? "indexing…" : `index ${indexing.state}`;
      const value = `${statusViewSummary(createStatusView(status))} · ${index}`;
      if (core.config.footer === "disabled") {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setFooter?.(undefined);
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, value);
      installAtelierFooter(
        ctx,
        status,
        intel,
        this.thinkingLevel,
        core.config.footer,
        this.modelName,
      );
    } catch (error) {
      ctx.ui.setStatus(STATUS_KEY, "Atelier unavailable");
      // A failed observation must not leave a previously valid custom footer
      // displaying stale repository, workflow, or intelligence state.
      ctx.ui.setFooter?.(undefined);
      ctx.ui.notify(errorMessage(error), "error");
    }
  }
}
