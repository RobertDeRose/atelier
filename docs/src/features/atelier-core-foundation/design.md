# Design — Atelier Core Foundation

## Metadata

- Beads feature root: `legacy delivery; predates Beads feature roots`
- Feature slug: `atelier-core-foundation`
- Design path: `docs/src/features/atelier-core-foundation/design.md`
- Implemented record: `docs/src/features/atelier-core-foundation/index.md`
- Status: delivered

## Feature Summary

The pre-dstack foundation established Atelier as a local-first workflow control plane with Jujutsu/Git repository observation, provider-neutral code intelligence, durable Working State, workspace recoverability, and Pi integration.

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

| Documentation concern      | Exact page                                           | Change                     |
|----------------------------|------------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`                  | Current supported behavior |
| Development                | `docs/src/development/setup.md`                      | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                                | Feature registration       |
| Implemented Feature Record | `docs/src/features/atelier-core-foundation/index.md` | Delivery and audit history |

## Validation Strategy

Historical implementation and release evidence is preserved in repository history. Current supported behavior is validated by the repository suite and documentation checks.

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

Pre-dstack architecture records and `docs/src/reference/changelog/implementation-plan.md`.
