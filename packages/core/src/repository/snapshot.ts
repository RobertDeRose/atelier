export interface RepositorySnapshot {
  repositoryId: string;
  workspaceId: string;
  vcs: "jj" | "git" | "none";
  headCommit: string;
  /** Stable source parent/baseline revision, excluding workflow-metadata churn. */
  sourceBaseCommit?: string;
  /** Source-only working-state fingerprint used for approval and evidence freshness. */
  sourceFingerprint?: string;
  changeId?: string;
  operationId?: string;
  dirtyGeneration: number;
  dirtyFingerprint: string;
  indexSchemaVersion: number;
}

/**
 * Return the application-source fingerprint used for approval, retrieval, and
 * validation freshness. Older persisted snapshots fall back to the raw dirty
 * fingerprint and therefore continue to fail closed.
 */
export function sourceSnapshotFingerprint(snapshot: RepositorySnapshot): string {
  return snapshot.sourceFingerprint ?? snapshot.dirtyFingerprint;
}

/** Return the stable application-source base revision for a snapshot. */
export function sourceSnapshotBase(snapshot: RepositorySnapshot): string {
  return snapshot.sourceBaseCommit ?? snapshot.headCommit;
}

/**
 * Stable source identity used by code indexes and evidence freshness.
 *
 * Raw Jujutsu change/operation identifiers intentionally do not participate:
 * editing Atelier, Beads, or provider metadata may advance those identifiers
 * without changing application source.
 */
export function sourceRevisionIdentity(snapshot: RepositorySnapshot): string {
  return [
    snapshot.vcs,
    snapshot.sourceBaseCommit ?? snapshot.headCommit,
    snapshot.sourceFingerprint ?? snapshot.dirtyFingerprint,
  ].join(":");
}
