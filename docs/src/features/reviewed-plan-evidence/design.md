# Design — Persist reviewed revisions and complete ManualEdit evidence

## Metadata

- Beads feature root: `atelier-cu0`
- Feature slug: `reviewed-plan-evidence`
- Design path: `docs/src/features/reviewed-plan-evidence/design.md`
- Implemented record: `docs/src/features/reviewed-plan-evidence/index.md`
- Status: delivered

## Feature Summary

Make direct plan editing a durable, restart-safe transaction whose complete structural result is the sole input to reconciliation.

In scope:

- Add behavior-first unit and integration scenarios before implementation for unchanged review, field edits, additions, removals, reordering, invalid plans, editor failure, concurrent source drift, and restart.
- Add typed workflow/review records in `packages/core/src/domain/types.ts`, including a durable workflow run/checkpoint and `ManualEdit` lifecycle (`started`, `completed`, `interrupted`, `failed`).
- Add a ledger migration and transactional helpers in `packages/core/src/ledger/sqlite-ledger.ts` so the current workflow checkpoint and its event are updated atomically and remain compatible with existing databases.
- Extract a reusable structural diff under `packages/core/src/planning/` that compares plan order and every parsed task field: ID, title, goal/description, scope, exclusions, dependencies, validation, completion criteria, notes, priority, and type.
- Replace the ad hoc `AtelierCore.recordPlanReview` path with begin/complete/cancel review operations that capture editor metadata, plan path, before/after content hashes, before/after repository snapshots, changed path, diagnostics, structural diff, and ambiguity/drift status.
- Keep full plan content in the plan file; store hashes and bounded structural evidence rather than duplicating unrestricted document text in ledger payloads.
- Preserve `ensurePlanDocument`, configured-editor precedence, and the existing Pi TUI suspension boundary.
- Export the new types/service through `packages/core/src/index.ts` and update `docs/PLAN_FORMAT.md` only where the canonical structural fields need clarification.

Out of scope:

- General source-file `ManualEdit` protection or semantic hunk comparison.
- Task-provider mutation, plan approval, or act-mode transition.
- A new editor adapter or alternate-screen implementation.

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

| Documentation concern      | Exact page                                          | Change                     |
|----------------------------|-----------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`                 | Current supported behavior |
| Development                | `docs/src/development/setup.md`                     | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                               | Feature registration       |
| Implemented Feature Record | `docs/src/features/reviewed-plan-evidence/index.md` | Delivery and audit history |

## Validation Strategy

A saved direct edit produces one completed `ManualEdit` with deterministic added, removed, reordered, and field-changed details.
An unchanged editor session is still valid review evidence but is reported as textually unchanged.
Blocking diagnostics, editor interruption, plan deletion, or concurrent source drift cannot advance the reviewed-plan checkpoint.
Restart reconstructs the pending/completed review without relying on Pi session messages.
Existing databases migrate in place; the pre-existing `.atelier/PLAN.md` and task/provider state are not deleted or rewritten implicitly.
Validation: Add focused tests in `tests/plan-parser.test.ts` and a new workflow/review test covering all structural fields and deterministic ordering.
Validation: Extend `tests/core.integration.test.ts` to close/reopen Core between review start and completion and verify durable recovery.
Validation: Add editor failure, deletion, unchanged review, and concurrent repository-drift cases without launching a real interactive editor.
Validation: Run the focused Node test files and `mise run typecheck`.

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

Closed Beads feature `atelier-cu0`; ATLR-1100 acceptance criteria satisfied; implementation 1a34b6a and validation-contract fix 57f5f24e25f615defa4110c875d8de828c8a244a.
