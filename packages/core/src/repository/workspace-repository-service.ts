import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CodeWorkspace } from "../code/types.ts";
import type { RepositorySnapshot } from "./snapshot.ts";
import { sourceSnapshotBase } from "./snapshot.ts";
import type { RepositoryCommitResult, RepositoryProvider } from "./repository-provider.ts";
import {
  repositoryBindingDigest,
  repositoryRevisionBinding,
  type RepositoryRevisionBinding,
} from "./revision-binding.ts";
import { isPathWithin } from "../security/path-boundary.ts";
import { isSourcePath, sourcePaths } from "./source-path.ts";
import { sha256 } from "../util/hash.ts";

export interface WorkspaceRepositoryContext {
  id: string;
  name: string;
  root: string;
  primary: boolean;
  provider: RepositoryProvider;
  baseline?: RepositoryRevisionBinding;
}

export interface WorkspaceRepositoryChanges {
  repositoryId: string;
  repositoryName: string;
  repositoryRoot: string;
  primary: boolean;
  provider: RepositoryProvider;
  baseline: RepositoryRevisionBinding;
  changedPaths: string[];
  absolutePaths: string[];
}

export interface WorkspaceRepositoryDiff {
  repositoryId: string;
  repositoryName: string;
  repositoryRoot: string;
  baselineHeadCommit: string;
  changedPaths: string[];
  qualifiedChangedPaths: string[];
  diff: string;
  diffHash: string;
  snapshot: RepositorySnapshot;
}

export interface WorkspaceRepositoryCommit {
  repositoryId: string;
  repositoryName: string;
  repositoryRoot: string;
  result: RepositoryCommitResult;
}

export interface WorkspaceCommitResult extends RepositoryCommitResult {
  repositories: WorkspaceRepositoryCommit[];
}

export interface WorkspaceMetadataState {
  repositories: Array<{
    repositoryId: string;
    repositoryName: string;
    repositoryRoot: string;
    paths: string[];
    qualifiedPaths: string[];
  }>;
  qualifiedPaths: string[];
}

function canonicalRelative(root: string, path: string): string {
  return relative(root, resolve(root, path)).replaceAll("\\", "/");
}

export class WorkspaceRepositoryService {
  readonly workspace: CodeWorkspace;
  readonly contexts: WorkspaceRepositoryContext[];
  private readonly approvedPaths: string[];

  constructor(options: {
    workspace: CodeWorkspace;
    primaryRoot: string;
    primaryProvider: RepositoryProvider;
    providerForRoot: (root: string) => RepositoryProvider;
    approvedPaths?: readonly string[];
    baselines?: readonly RepositoryRevisionBinding[];
  }) {
    this.workspace = options.workspace;
    const baselineById = new Map((options.baselines ?? []).map((binding) => [binding.repositoryId, binding]));
    this.contexts = options.workspace.repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      root: repository.root,
      primary: repository.root === options.primaryRoot,
      provider: repository.root === options.primaryRoot
        ? options.primaryProvider
        : options.providerForRoot(repository.root),
      ...(baselineById.get(repository.id) === undefined ? {} : { baseline: baselineById.get(repository.id)! }),
    }));
    this.approvedPaths = [...new Set(options.approvedPaths ?? [])].map((path) => resolve(path)).sort();
  }

  currentBindings(): RepositoryRevisionBinding[] {
    return this.contexts.map((context) => repositoryRevisionBinding(context.id, context.provider.snapshot()));
  }

  evidenceSnapshot(): RepositorySnapshot {
    const primary = this.primary().provider.snapshot();
    const fingerprint = sha256(JSON.stringify(this.currentBindings().map((binding) => ({
      repositoryId: binding.repositoryId,
      snapshotRepositoryId: binding.snapshotRepositoryId,
      sourceFingerprint: binding.sourceFingerprint,
      indexSchemaVersion: binding.indexSchemaVersion,
    })).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))));
    return {
      ...primary,
      workspaceId: this.workspace.id,
      sourceFingerprint: fingerprint,
      dirtyFingerprint: fingerprint,
    };
  }

  approvedChanges(fromBaseline: boolean): WorkspaceRepositoryChanges[] {
    return this.contexts.map((context) => {
      const baseline = this.requireBaseline(context);
      const observed = sourcePaths(fromBaseline && baseline.vcs !== "none"
        ? context.provider.changedPathsFrom(baseline.sourceBaseCommit)
        : context.provider.changedPaths());
      const changedPaths = observed.filter((path) => this.owner(resolve(context.root, path))?.id === context.id);
      const approved = this.approvedPaths.filter((path) => this.owner(path)?.id === context.id);
      const outside = changedPaths.filter((path) => {
        const absolute = resolve(context.root, path);
        return !approved.some((approvedRoot) => isPathWithin(absolute, approvedRoot, "write"));
      });
      if (outside.length > 0) {
        throw new Error(
          `Source changes in workspace repository ${context.id} exceed the reviewed task scope: ${outside.join(", ")}.`,
        );
      }
      return {
        repositoryId: context.id,
        repositoryName: context.name,
        repositoryRoot: context.root,
        primary: context.primary,
        provider: context.provider,
        baseline,
        changedPaths,
        absolutePaths: changedPaths.map((path) => resolve(context.root, path)),
      };
    });
  }

  diff(fromBaseline = true): { repositories: WorkspaceRepositoryDiff[]; diff: string; diffHash: string; changedPaths: string[] } {
    const changes = this.approvedChanges(fromBaseline).filter((entry) => entry.changedPaths.length > 0);
    const repositories = changes.map((entry): WorkspaceRepositoryDiff => {
      if (entry.baseline.vcs === "none") {
        throw new Error(`Final diff review requires a revision-aware baseline for workspace repository ${entry.repositoryId}.`);
      }
      const diff = entry.changedPaths
        .map((path) => entry.provider.diffFrom(entry.baseline.sourceBaseCommit, path))
        .filter((item) => item.trim())
        .join("\n");
      return {
        repositoryId: entry.repositoryId,
        repositoryName: entry.repositoryName,
        repositoryRoot: entry.repositoryRoot,
        baselineHeadCommit: entry.baseline.sourceBaseCommit,
        changedPaths: entry.changedPaths,
        qualifiedChangedPaths: entry.changedPaths.map((path) => this.qualify(entry.repositoryId, path)),
        diff,
        diffHash: sha256(diff),
        snapshot: entry.provider.snapshot(),
      };
    });
    const diff = repositories.map((repository) => {
      if (this.contexts.length === 1) return repository.diff;
      return [
        `### Repository ${repository.repositoryId} (${repository.repositoryRoot})`,
        repository.diff,
      ].join("\n");
    }).filter((item) => item.trim()).join("\n\n");
    return {
      repositories,
      diff,
      diffHash: sha256(diff),
      changedPaths: repositories.flatMap((repository) => repository.qualifiedChangedPaths),
    };
  }

  commit(message: string): WorkspaceCommitResult {
    const changes = this.approvedChanges(false).filter((entry) => entry.changedPaths.length > 0);
    if (changes.length === 0) throw new Error("No approved source changes are available to commit.");
    const committed: WorkspaceRepositoryCommit[] = [];
    try {
      for (const entry of changes) {
        committed.push({
          repositoryId: entry.repositoryId,
          repositoryName: entry.repositoryName,
          repositoryRoot: entry.repositoryRoot,
          result: entry.provider.commit(message, entry.changedPaths),
        });
      }
    } catch (error) {
      const completed = committed.map((entry) => entry.repositoryId).join(", ") || "none";
      throw new Error(
        `Workspace commit failed after completing repositories: ${completed}. `
        + `Inspect each repository before retrying. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return {
      message,
      changedPaths: committed.flatMap((entry) =>
        entry.result.changedPaths.map((path) => this.qualify(entry.repositoryId, path))),
      snapshot: this.primary().provider.snapshot(),
      repositories: committed,
    };
  }

  localChangeCreated(): boolean {
    const changes = this.approvedChanges(true).filter((entry) => entry.changedPaths.length > 0);
    return changes.length > 0 && changes.every((entry) =>
      sourceSnapshotBase(entry.provider.snapshot()) !== entry.baseline.sourceBaseCommit);
  }

  sourceClean(): boolean {
    return this.approvedChanges(false).every((entry) => entry.changedPaths.length === 0);
  }


  sourceChangedPaths(): string[] {
    return this.contexts.flatMap((context) => sourcePaths(context.provider.changedPaths())
      .filter((path) => this.owner(resolve(context.root, path))?.id === context.id)
      .map((path) => this.qualify(context.id, path)));
  }

  metadataState(): WorkspaceMetadataState {
    const repositories = this.contexts.map((context) => {
      const paths = context.provider.rawChangedPaths()
        .filter((path) => !isSourcePath(path))
        .filter((path) => this.owner(resolve(context.root, path))?.id === context.id)
        .sort();
      return {
        repositoryId: context.id,
        repositoryName: context.name,
        repositoryRoot: context.root,
        paths,
        qualifiedPaths: paths.map((path) => this.qualify(context.id, path)),
      };
    }).filter((entry) => entry.paths.length > 0);
    return {
      repositories,
      qualifiedPaths: repositories.flatMap((entry) => entry.qualifiedPaths),
    };
  }

  commitMetadata(message: string): WorkspaceRepositoryCommit[] {
    const metadata = this.metadataState();
    const committed: WorkspaceRepositoryCommit[] = [];
    try {
      for (const entry of metadata.repositories) {
        const context = this.contexts.find((candidate) => candidate.id === entry.repositoryId)!;
        committed.push({
          repositoryId: context.id,
          repositoryName: context.name,
          repositoryRoot: context.root,
          result: context.provider.commitMetadata(message, entry.paths),
        });
      }
    } catch (error) {
      const completed = committed.map((entry) => entry.repositoryId).join(", ") || "none";
      throw new Error(
        `Workspace metadata finalization failed after completing repositories: ${completed}. `
        + `Inspect each repository before retrying. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return committed;
  }

  rawChangedPaths(): string[] {
    return this.contexts.flatMap((context) => context.provider.rawChangedPaths()
      .filter((path) => this.owner(resolve(context.root, path))?.id === context.id)
      .map((path) => this.qualify(context.id, path)));
  }

  rawChangedFingerprints(): Record<string, string> {
    return Object.fromEntries(this.contexts.flatMap((context) => context.provider.rawChangedPaths()
      .filter((path) => this.owner(resolve(context.root, path))?.id === context.id)
      .map((path) => {
        const qualified = this.qualify(context.id, path);
        const absolute = resolve(context.root, path);
        if (!existsSync(absolute)) return [qualified, "missing"] as const;
        try {
          const stat = statSync(absolute);
          if (!stat.isFile()) return [qualified, `non-file:${stat.mode}:${stat.size}`] as const;
          return [qualified, `file:${stat.size}:${sha256(readFileSync(absolute))}`] as const;
        } catch {
          return [qualified, "unreadable"] as const;
        }
      })));
  }

  qualify(repositoryId: string, path: string): string {
    const context = this.contexts.find((candidate) => candidate.id === repositoryId);
    if (context === undefined) throw new Error(`Unknown workspace repository: ${repositoryId}`);
    return context.primary ? canonicalRelative(context.root, path) : `${repositoryId}::${canonicalRelative(context.root, path)}`;
  }

  private primary(): WorkspaceRepositoryContext {
    const primary = this.contexts.find((context) => context.primary);
    if (primary === undefined) throw new Error("The workspace does not include the primary Atelier repository.");
    return primary;
  }

  private owner(path: string): WorkspaceRepositoryContext | undefined {
    return this.contexts
      .filter((context) => isPathWithin(path, context.root, "write"))
      .sort((left, right) => right.root.length - left.root.length)[0];
  }

  private requireBaseline(context: WorkspaceRepositoryContext): RepositoryRevisionBinding {
    if (context.baseline !== undefined) return context.baseline;
    return repositoryRevisionBinding(context.id, context.provider.snapshot());
  }
}
