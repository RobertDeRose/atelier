import { resolve } from "node:path";
import type { RepositorySnapshot } from "./snapshot.ts";
import type { RepositoryProvider, RepositoryProviderStatus, RepositoryCommitResult } from "./repository-provider.ts";
import { sha256 } from "../util/hash.ts";

/** Non-executing provider used before project trust or outside a supported VCS. */
export class DirectoryRepositoryProvider implements RepositoryProvider {
  readonly name = "none" as const;
  private readonly root: string;
  private readonly indexSchemaVersion: number;
  private readonly reason: string;

  constructor(options: { root: string; indexSchemaVersion?: number; reason?: string }) {
    this.root = resolve(options.root);
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.reason = options.reason ?? "No supported repository provider is active.";
  }

  status(): RepositoryProviderStatus {
    return { provider: "none", available: true, repository: false, reason: this.reason };
  }

  snapshot(): RepositorySnapshot {
    const identity = sha256(this.root);
    return {
      repositoryId: `directory:${identity.slice(0, 24)}`,
      workspaceId: identity.slice(0, 16),
      vcs: "none",
      headCommit: "none",
      dirtyGeneration: 0,
      dirtyFingerprint: `directory:${identity}`,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  changedPaths(): string[] { return []; }
  changedPathsFrom(_reference: string): string[] { return []; }
  diff(): string { return ""; }
  diffFrom(_reference: string, _path?: string): string { return ""; }
  listFiles(): string[] { return []; }
  commit(_message: string, _paths?: string[]): RepositoryCommitResult { throw new Error(this.reason); }
}
