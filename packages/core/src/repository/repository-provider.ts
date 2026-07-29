import type { RepositorySnapshot } from "./snapshot.ts";

export interface RepositoryProviderStatus {
  provider: "jj" | "git" | "none";
  available: boolean;
  repository: boolean;
  reason?: string;
}

export interface RepositoryCommitResult {
  message: string;
  changedPaths: string[];
  snapshot: RepositorySnapshot;
}

export interface RepositoryProvider {
  readonly name: "jj" | "git" | "none";
  status(): RepositoryProviderStatus;
  snapshot(): RepositorySnapshot;
  changedPaths(): string[];
  rawChangedPaths(): string[];
  changedPathsFrom(reference: string): string[];
  diff(path?: string): string;
  diffFrom(reference: string, path?: string): string;
  listFiles(): string[];
  commit(message: string, paths?: string[]): RepositoryCommitResult;
  commitMetadata(message: string, paths: string[]): RepositoryCommitResult;
}
