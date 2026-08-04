# Design — Persist mutation and focused-validation evidence in Working State

## Metadata

- Beads feature root: `atelier-h53`
- Feature slug: `mutation-validation-evidence`
- Design path: `docs/src/features/mutation-validation-evidence/design.md`
- Implemented record: `docs/src/features/mutation-validation-evidence/index.md`
- Status: delivered

## Feature Summary

Make implementation and validation progress durable, freshness-aware, cancellable, and sufficient for safe resume.

In scope:

- Write behavior tests first for successful/failed/interrupted tool execution, changed paths, focused selection, no-match behavior, validation cancellation, stale passes, rerun, restart, and task closure gates.
- Add a Core execution-evidence boundary that records tool call ID/name, action classification, execution grant, permission decision/grant, before/after repository snapshots, observed changed paths, result state, and bounded error metadata.
- Use post-execution repository snapshots to distinguish an allowed attempt from an observed mutation; never claim an edit occurred solely because authorization was granted.
- Make `ValidationService.run` asynchronous and abort-aware using direct argument-array process execution, bounded output capture, and durable `passed`, `failed`, or `interrupted` evidence.
- Persist focused-validation selection as evidence with changed paths/symbols, selected names, reasons, plan/task/execution bindings, and the pre-run snapshot.
- Route focused and full-suite categories through independent policy actions. Never promote a no-match focused plan into a full suite.
- Keep conservative freshness: evidence is current only when its snapshot fingerprint equals the present repository fingerprint; expose the newer changed paths/fingerprint as the stale reason.
- Extend Working State and Markdown rendering with workflow checkpoint, approval/reconciliation identity, execution-grant status, execution evidence, selected focused validations, current validation, and stale validation summaries.
- Record validation outcomes against the active task in the ledger. Require current passing evidence for all configured required focused checks before the workflow offers task closure; closure remains an explicit user action through `TaskProvider`.
- After explicit task closure, invalidate the execution grant and expose the next provider-ready approved-plan task without starting it.

Out of scope:

- Language-semantic changed-symbol discovery beyond provider-neutral symbols already supplied to validation selection.
- Selective compatibility weaker than full dirty-fingerprint equality.
- Automatic full-suite execution or flaky-test adjudication.

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

| Documentation concern      | Exact page                                                | Change                     |
|----------------------------|-----------------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`                       | Current supported behavior |
| Development                | `docs/src/development/setup.md`                           | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                                     | Feature registration       |
| Implemented Feature Record | `docs/src/features/mutation-validation-evidence/index.md` | Delivery and audit history |

## Validation Strategy

Every authorized mutating tool result produces durable success/failure/interruption evidence with before/after repository identity.
Focused selection is explainable, runs only configured checks, and persists its result against the active workflow/task.
A pass becomes visibly stale after the next repository fingerprint change and cannot satisfy task closure until rerun.
Interrupted validation is never shown as pass or failure, and cancellation leaves no child process.
A fresh Core/Pi session reconstructs the active task, execution grant, observed changes, validation plan, current/stale evidence, and next action from Working State.
Validation: Expand `tests/validation-service.test.ts` for abort, bounded output, failed/interrupted persistence, no-match, and staleness after source change.
Validation: Extend `tests/reconciliation-state.test.ts` or add a focused Working State test for current/stale validation, execution evidence, grant status, and restart.
Validation: Add policy tests proving focused permission does not imply full-suite or command permission.
Validation: Run focused validation/state/policy tests and `mise run typecheck`.

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

Closed Beads feature `atelier-h53`; ATLR-1103 acceptance criteria satisfied; commit bdf29772ad6fc05bbc6db2a6fc89307b9e59102f.
