import type { RepositorySnapshot } from "./snapshot.ts";

export interface RepositoryProviderStatus {
  provider: "jj" | "git" | "none";
  available: boolean;
  repository: boolean;
  reason?: string;
}

export interface RepositoryDisplayState {
  vcs: "jj" | "git" | "none";
  /** Preferred human-readable bookmark or branch. */
  label?: string;
  /** Secondary short identity, normally a Jujutsu change or Git commit. */
  revision?: string;
  state: "clean" | "dirty" | "conflicted" | "unknown";
  detached?: boolean;
}


export interface RepositoryRecoveryState {
  provider: "jj" | "git" | "none";
  /** Provider-native state needed to restore staged/working-copy semantics. */
  native?: Record<string, unknown>;
}

export interface RepositoryRecoveryCheckpoint {
  paths: string[];
  state: RepositoryRecoveryState;
}

export interface RepositoryCommitResult {
  message: string;
  changedPaths: string[];
  snapshot: RepositorySnapshot;
}

export type RepositoryPathState = "missing" | "tracked_clean" | "tracked_dirty" | "untracked" | "ignored" | "unknown";

export interface RepositoryObservationMetrics {
  durationMs: number;
  subprocesses: number;
  filesHashed: number;
  bytesHashed: number;
  cacheHit: boolean;
}

export interface RepositoryObservation {
  status: RepositoryProviderStatus;
  snapshot: RepositorySnapshot;
  displayState: RepositoryDisplayState;
  root: string;
  rawChangedPaths: string[];
  changedPaths: string[];
  files?: string[];
  pathStates: Record<string, RepositoryPathState>;
  observedAt: string;
  metrics: RepositoryObservationMetrics;
}

export interface RepositoryObserveOptions {
  paths?: readonly string[];
  includeFiles?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

export interface RepositoryProvider {
  readonly name: "jj" | "git" | "none";
  /** Async request-scoped observation for interactive paths. */
  observe?(options?: RepositoryObserveOptions): Promise<RepositoryObservation>;
  peekObservation?(): RepositoryObservation | undefined;
  invalidateObservation?(): void;
  /** Batch classification avoids one VCS process per affected path. */
  classifyPaths?(paths: readonly string[], options?: { signal?: AbortSignal }): Promise<Record<string, RepositoryPathState>>;
  status(): RepositoryProviderStatus;
  snapshot(): RepositorySnapshot;
  displayState?(): RepositoryDisplayState;
  changedPaths(): string[];
  rawChangedPaths(): string[];
  changedPathsFrom(reference: string): string[];
  diff(path?: string): string;
  diffFrom(reference: string, path?: string): string;
  listFiles(): string[];
  classifyPath?(path: string): RepositoryPathState;
  captureRecoveryState?(paths: string[]): RepositoryRecoveryState;
  restoreRecoveryState?(state: RepositoryRecoveryState, paths: string[]): void;
  verifyRecoveryState?(state: RepositoryRecoveryState, paths: string[]): void;
  commit(message: string, paths?: string[]): RepositoryCommitResult;
  commitMetadata(message: string, paths: string[]): RepositoryCommitResult;
}
