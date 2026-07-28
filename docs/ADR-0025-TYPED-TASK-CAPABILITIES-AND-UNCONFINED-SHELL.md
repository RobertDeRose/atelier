# ADR-0025: Approve typed task capabilities and treat shell as unconfined

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Classifying arbitrary shell text as read-only was not a defensible authorization boundary. Wrappers, execution flags, process substitution, redirection, and ambiguous VCS subcommands could mutate or access external state while appearing harmless.

## Decision

Exact plan approval atomically creates a narrow task capability bundle for typed in-repository file writes, declared validation, task operations, dependency changes, and local change creation. The bundle is hashed and bound to the execution grant.

Generic shell is always an unconfined `command.execute` operation. It never inherits task capabilities and requires a single-operation approval. Shell classification remains diagnostic metadata only. Typed reads and writes carry resolved real paths and are constrained to approved roots with symlink-aware checks.

## Consequences

- Routine typed task work follows the intended one-approval workflow.
- Each generic shell operation remains visible and independently authorized.
- Atelier does not claim that string parsing confines a shell process.
- An operating-system sandbox remains the future mechanism for stronger shell confinement.
