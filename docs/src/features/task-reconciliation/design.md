# Design — Reconcile the complete approved task projection safely

## Metadata

- Beads feature root: `atelier-8xk`
- Feature slug: `task-reconciliation`
- Design path: `docs/src/features/task-reconciliation/design.md`
- Implemented record: `docs/src/features/task-reconciliation/index.md`
- Status: delivered

## Feature Summary

Produce a provider-neutral, canonical, idempotent projection of the reviewed plan, including dependency removals and explicit retirement, that can recover from interruption without duplicate tasks.

In scope:

- Write reconciliation behavior tests first for create/adopt/update/link/unlink/retire, reordering, repeated preview/apply, partial failure, restart, ambiguous identity, and provider drift.
- Extend `ReconciliationOperation` and `TaskReconciliation` with normalized field changes, unlink, retire, adopt, deterministic operation IDs, provider identity, and a canonical reconciliation digest.
- Extend `TaskProvider` only with provider-neutral capabilities required by the operations, including safe dependency removal or explicit capability reporting. Keep every Beads command inside `BeadsCliTaskProvider`.
- Make the stable plan marker (`planTaskId`) round-trip through in-memory and Beads records so a restart can adopt exactly one externally created task if a crash occurred before `plan_task_mappings` was stored.
- Compare plan mappings with provider state to preview tasks removed from the plan as retirements and dependencies removed from the plan as unlinks. Never delete provider tasks.
- Update every surviving mapping to the newly reconciled plan hash, including reorder-only revisions that require no provider mutation.
- Record started/completed/failed operation checkpoints and make apply resume by inspecting provider state rather than blindly replaying writes.
- Surface unsupported provider behavior, disappeared records, reused stable IDs, multiple stable-marker matches, cycles, and unexpected provider edits as conflicts.
- Preserve plan-order tie-breaking in `WorkingStateBuilder` and all existing provider-outage degradation for read-only state construction.

Out of scope:

- Beads database access, provider-specific objects in Core, or implicit provider initialization.
- Automatic task activation or permission grants.
- Recursive traversal of relationship types other than the explicit blocking dependency semantics.

## User Intent

Provide a durable, reviewable implementation record instead of relying on session history.

## Goals

Preserve the feature's accepted behavior, safety boundaries, and validation evidence.

## Non-Goals

This reconstructed design does not change runtime behavior or create an alternate workflow authority.

## User-Facing Behavior

Current behavior is defined by the linked reader-facing architecture, operations, development, and reference pages.

## Requirements

### Functional Requirements

The feature delivers the behavior recorded by its closed Beads acceptance criteria.

### Quality Requirements

Operations remain bounded, deterministic where applicable, redacted, cancellable, and fail closed on ambiguous state.

### Compatibility and Migration Requirements

This record was reconstructed from pre-dstack implementation and Beads evidence; it does not alter existing runtime data.

## Existing Context

Atelier Core owns workflow state, repository evidence, validation, recovery, and closure. Beads owns live task state.

## Proposed Design

Use existing typed Core, provider, repository, policy, and ledger contracts; do not move their authority into a client or provider.

## Architecture Consistency

### Existing Patterns Reused

Typed contracts, immutable workspace identity, bounded process and payload handling, and durable ledger evidence.

### Invariants Preserved

Pi, task providers, and code providers remain integrations rather than workflow authorities.

### New Decisions Introduced

None. This is a reconstructed delivered design.

### Architecture Documentation Changes

The current architecture overview replaces the legacy decision-document catalog as the reader-facing architecture source.

## Operational Considerations

Use the current operator and development documentation for commands, configuration, recovery, and support guidance.

## Documentation Impact

| Documentation concern      | Exact page                                       | Change                     |
|----------------------------|--------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`              | Current supported behavior |
| Development                | `docs/src/development/setup.md`                  | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                            | Feature registration       |
| Implemented Feature Record | `docs/src/features/task-reconciliation/index.md` | Delivery and audit history |

## Validation Strategy

Preview precisely describes creates, adoptions, updates, links, unlinks, retirements, no-ops, and conflicts for the reviewed hash.
Equivalent inputs produce the same digest and operation IDs regardless of provider return ordering.
Applying or resuming an unchanged preview converges exactly once and a subsequent preview is empty.
A crash after provider create but before mapping storage cannot create a duplicate; ambiguous matches block safely.
Removed provider tasks are closed only as an operation visible in the explicitly approved preview, and removed dependencies are not silently retained.
Core and Working State remain unaware of Beads command/storage details.
Validation: Expand `tests/reconciliation-state.test.ts` with BDD scenarios for every operation and crash boundary, including no duplicate create after reopen.
Validation: Expand `tests/beads-cli-provider.test.ts` and in-memory provider tests to cover stable markers, unlink, retirement, and argument-array invocation with shell metacharacters.
Validation: Add a provider conformance fixture shared by in-memory and fake-Beads adapters.
Validation: Run focused reconciliation/provider tests and `mise run typecheck`.
Validation: If the pinned `bd` executable is available, run a disposable-repository live conformance for create, dependency add/remove, update, close, and ready; do not make the ordinary suite depend on it.

## Implementation Decomposition

The closed Beads feature records the implementation slices and dependencies.

## Dependencies and Parallelism

Beads is authoritative for historical task dependencies and implementation evidence.

## Rollout and Migration

No additional rollout or migration is performed by this documentation reconstruction.

## Risks and Tradeoffs

Current code, tests, and reader-facing documentation take precedence if historical sources disagree.

## Rejected Alternatives

Do not restore a separate legacy decision-document catalog or treat historical notes as current workflow authority.

## Open Questions

None for this delivered feature. New work belongs in Beads and Planned Features.

## Deferred Decisions

Future behavior requires a new planned feature and Beads execution graph.

## Planning Record

### Questions Asked and Answers

The closed feature's Beads description and acceptance criteria establish the delivered scope.

### Assumptions

The documented close evidence accurately identifies the accepted implementation.

### Design Changes During Planning

This design was reconstructed during the dstack migration.

### Source Material

Closed Beads feature `atelier-8xk`; ATLR-1101 acceptance criteria satisfied; commit a1840ff4d3404ca2711fa5a3dce72994efad2bdf.
