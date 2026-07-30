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

export interface RepositoryProvider {
  readonly name: "jj" | "git" | "none";
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
