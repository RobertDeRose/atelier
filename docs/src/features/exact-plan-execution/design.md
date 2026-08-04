# Design — Enforce exact approval and task-scoped execution grants

## Metadata

- Beads feature root: `atelier-s4d`
- Feature slug: `exact-plan-execution`
- Design path: `docs/src/features/exact-plan-execution/design.md`
- Implemented record: `docs/src/features/exact-plan-execution/index.md`
- Status: delivered

## Feature Summary

Move from a reviewed plan to act mode only through one exact, inspectable approval transaction followed by successful reconciliation and task activation.

In scope:

- Add failing-first workflow tests for approval rejection, hash drift, provider drift, partial reconciliation, unavailable provider, no ready task, task claim failure, grant invalidation, cancellation, and restart.
- Introduce a Core workflow coordinator (for example under `packages/core/src/workflow/`) with explicit prepare, approve/apply, start-task, cancel, and resume operations used by both clients.
- Define typed `PlanApproval`, `ReconciliationTransaction`, and `ExecutionGrant` records with the bindings and lifecycle described above.
- Persist execution grants and their invalidation reason in the ledger; bind execution-time `PermissionGrant` records to an active execution grant where applicable.
- Change `PolicyEngine` inputs so act-mode agent mutations require both a valid execution grant for the request task/workspace and the independently required permission grant. Reads remain approval-free.
- Recompute the plan hash and reconciliation digest immediately before mutation. Apply the approved reconciliation, re-preview, select an approved-plan ready task, claim it through `TaskProvider`, and only then set act mode/current task and issue the execution grant.
- Make task-provider initialization a separately confirmed preparation step and keep plan mode's general prohibition on arbitrary task mutation intact.
- Add task-start behavior for a later ready task after the previous execution grant ends; require explicit confirmation while reusing the unchanged plan approval.
- Add cancellation that revokes execution-linked permissions without reverting source or altering provider task status.
- Fail closed on resume when any grant binding is invalid, while preserving enough checkpoint detail to retry safely.

Out of scope:

- Bundled source-write permission, automatic repository changes, or automatic next-task execution.
- Automatic task closure after an agent response.
- Cross-repository execution grants in one task; the current configured workspace identity is the boundary.

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

| Documentation concern      | Exact page                                        | Change                     |
|----------------------------|---------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`               | Current supported behavior |
| Development                | `docs/src/development/setup.md`                   | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                             | Feature registration       |
| Implemented Feature Record | `docs/src/features/exact-plan-execution/index.md` | Delivery and audit history |

## Validation Strategy

No task-provider operation occurs before approval of the exact displayed hash/digest, except separately confirmed provider initialization.
Rejection, changed plan/provider state, conflicts, or partial failure cannot create act mode or an execution grant.
Successful transition leaves an applied reconciliation, a claimed approved-plan task, act mode, and one valid task-scoped execution grant in durable state.
The grant conveys no action permission and is invalidated under every condition listed in this plan.
Cancellation and restart are deterministic, auditable, and never revert repository content.
Validation: Extend `tests/policy-engine.test.ts` for the two-key rule: execution authorization plus action permission.
Validation: Add coordinator integration tests with in-memory and failing providers for exact confirmation and all invalidation conditions.
Validation: Verify one-operation permissions are revoked after success, failure, and interruption.
Validation: Verify restart preserves a still-valid task-scoped execution grant and rejects a stale plan/provider/workspace binding.
Validation: Run focused policy/workflow tests and `mise run typecheck`.

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

Closed Beads feature `atelier-s4d`; ATLR-1102 acceptance criteria satisfied; commit f3b8904c63f5ca612b377e15abc370060c451dfc.
