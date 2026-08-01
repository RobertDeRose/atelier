import { existsSync } from "node:fs";
import type { RepositorySnapshot } from "./snapshot.ts";
import type {
  RepositoryProvider,
  RepositoryProviderStatus,
  RepositoryCommitResult,
  RepositoryPathState,
  RepositoryDisplayState,
  RepositoryObservation,
  RepositoryObserveOptions,
} from "./repository-provider.ts";
import { sha256 } from "../util/hash.ts";
import { canonicalRepositoryRoot, repositoryPathTargets } from "./repository-path.ts";

/** Non-executing provider used outside a supported VCS. */
export class DirectoryRepositoryProvider implements RepositoryProvider {
  readonly name = "none" as const;
  private readonly root: string;
  private readonly indexSchemaVersion: number;
  private readonly reason: string;

  constructor(options: { root: string; indexSchemaVersion?: number; reason?: string }) {
    this.root = canonicalRepositoryRoot(options.root);
    this.indexSchemaVersion = options.indexSchemaVersion ?? 1;
    this.reason = options.reason ?? "No supported repository provider is active.";
  }

  async observe(options: RepositoryObserveOptions = {}): Promise<RepositoryObservation> {
    const snapshot = this.snapshot();
    const targets = repositoryPathTargets(this.root, options.paths ?? [], "write");
    return {
      status: this.status(),
      snapshot,
      displayState: this.displayState(),
      root: this.root,
      rawChangedPaths: [],
      changedPaths: [],
      ...(options.includeFiles ? { files: [] } : {}),
      pathStates: Object.fromEntries(targets.flatMap((target) => {
        const state: RepositoryPathState = existsSync(target.entry) ? "untracked" : "missing";
        return [...new Set([target.key, target.entry])]
          .map((path) => [path, state] as const);
      })),
      observedAt: new Date().toISOString(),
      metrics: { durationMs: 0, subprocesses: 0, filesHashed: 0, bytesHashed: 0, cacheHit: true },
    };
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
      sourceBaseCommit: "none",
      sourceFingerprint: `directory:${identity}`,
      dirtyGeneration: 0,
      dirtyFingerprint: `directory:${identity}`,
      indexSchemaVersion: this.indexSchemaVersion,
    };
  }

  displayState(): RepositoryDisplayState {
    return { vcs: "none", state: "unknown" };
  }

  changedPaths(): string[] { return []; }
  rawChangedPaths(): string[] { return []; }
  changedPathsFrom(_reference: string): string[] { return []; }
  diff(): string { return ""; }
  diffFrom(_reference: string, _path?: string): string { return ""; }
  listFiles(): string[] { return []; }
  classifyPath(path: string): RepositoryPathState {
    const target = repositoryPathTargets(this.root, [path], "write")[0];
    return target !== undefined && existsSync(target.entry) ? "untracked" : "missing";
  }
  commitMetadata(_message: string, _paths: string[]): RepositoryCommitResult { throw new Error("Directory repository provider cannot create metadata commits."); }
  commit(_message: string, _paths?: string[]): RepositoryCommitResult { throw new Error(this.reason); }
}
