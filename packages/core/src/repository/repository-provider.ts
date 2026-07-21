import type { RepositorySnapshot } from "../domain/types.ts";

export interface RepositoryProviderStatus {
  provider: "jj" | "git" | "none";
  available: boolean;
  repository: boolean;
  reason?: string;
}

export interface RepositoryProvider {
  readonly name: "jj" | "git" | "none";
  status(): RepositoryProviderStatus;
  snapshot(): RepositorySnapshot;
  changedPaths(): string[];
  diff(path?: string): string;
  listFiles(): string[];
}
