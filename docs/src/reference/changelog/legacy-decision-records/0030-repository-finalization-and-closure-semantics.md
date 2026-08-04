# Legacy Decision Record 0030 — Repository finalization and closure semantics

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Application-source freshness must ignore Atelier and task-provider metadata, but a closure policy described as repository-clean cannot report success while tracked `.atelier` or `.beads` files remain dirty. Typed reads also need to distinguish a nonexistent in-root target from a path escaping through an existing symlink.

## Decision

Atelier models source cleanliness and whole-repository cleanliness separately. `requireCleanSource` gates the pre-close completion predicate. `requireCleanRepository` causes typed task closure to finalize non-source workflow/provider metadata in a separate local commit or Jujutsu change and verify raw repository cleanliness before recording completion. The legacy `requireCleanGit` field maps to both policies.

Typed reads resolve the nearest existing ancestor, canonicalize all existing symlinks, and then permit the underlying read tool to report a missing final component. Paths below escaping symlinks remain outside the approved boundary.

Working State and `nextAction` are driven by structured blocker codes. A completed workflow without an active execution grant is reported as completed rather than blocked.

## Consequences

- The implementation change remains limited to reviewed source paths.
- Workflow/provider metadata receives a separate auditable change.
- Whole-repository clean closure is truthful and testable with raw VCS status.
- A provider-close success followed by metadata-finalization failure is reported as a failed close and can be reconciled as an external closure; it is never recorded as successful completion.
