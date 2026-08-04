# Legacy Decision Record 0001 — Use Jujutsu as the Primary Repository Model

- Status: Accepted
- Date: 2026-07-20

## Context

Atelier needs stable conceptual change identity, operation-level recovery, explicit workspaces for concurrency, and a clean publication boundary. Git branches, staging, and dirty-tree semantics are not the intended local model.

## Decision

Use Jujutsu as Atelier's primary local repository provider. Use change IDs, commit IDs, operation IDs, workspaces, conflicts, and bookmarks as first-class repository state. Retain Git only as a compatibility fallback and GitHub publication protocol.

Provider auto-detection prefers an initialized Jujutsu repository. Git is selected only when Jujutsu is unavailable or the working directory is not a Jujutsu repository.

## Consequences

- Repository snapshots and validation evidence include Jujutsu identity.
- Operation IDs become audit and recovery boundaries.
- Bookmarks are created or moved only for publication.
- Manual Edits do not automatically create changes.
- Parallel agents require separate Jujutsu workspaces.
- Git-specific terminology cannot define provider-neutral interfaces.
