# Legacy Decision Record 0025 — Approve typed task constraints and treat shell as unconfined

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Classifying arbitrary shell text as read-only was not a defensible authorization boundary. Wrappers, execution flags, process substitution, redirection, and ambiguous VCS subcommands could mutate or access external state while appearing harmless.

## Decision

Exact plan approval atomically creates a narrow task capability bundle for typed in-repository file writes, declared validation, task operations, dependency changes, and local change creation. The bundle is hashed and bound to the execution grant.

Generic shell remains a `command.execute` operation and never inherits typed task capabilities. Its concrete filesystem effects are still analyzed before workspace-policy evaluation: writes identified during an active reviewed task are automatically recoverable only inside that task's approved write paths; an identified write outside those paths requires one-time approval even when an OS sandbox is available. Ambiguous shell effects remain approval-gated. Typed reads and writes carry resolved real paths and are constrained to approved roots with symlink-aware checks.

## Consequences

- Routine typed task work follows the intended one-approval workflow.
- Each generic shell operation remains visible and independently authorized.
- Reviewed task write paths prevent concrete shell writes from inheriting workspace-wide auto-allow.
- Atelier does not claim that string parsing confines a shell process.
- An operating-system sandbox remains the future mechanism for stronger shell confinement.

## Supersession

ADR-0032 removed filesystem permission grants and the universally unconfined-shell model. Reviewed task metadata now constrains workflow scope only. Concrete tool and shell effects are evaluated through immutable workspace containment, VCS recoverability, exact checkpoints, likely-secret rules, privilege escalation, and the shared OS sandbox path.
