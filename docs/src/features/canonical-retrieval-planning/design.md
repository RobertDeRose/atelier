# Design — Define canonical retrieval identity and phased query plans

## Metadata

- Beads feature root: `atelier-whg`
- Feature slug: `canonical-retrieval-planning`
- Design path: `docs/src/features/canonical-retrieval-planning/design.md`
- Implemented record: `docs/src/features/canonical-retrieval-planning/index.md`
- Status: delivered

## Feature Summary

Create provider-neutral domain contracts that distinguish broad semantic discovery from exact symbol resolution and make safe reuse decisions deterministic.

In scope:

- Write unit tests first for conservative text normalization, sorted scope filters, operation-specific keys, requested-limit handling, Jujutsu/Git revision vectors, provider/index identity, and multi-repository isolation.
- Add typed retrieval session, canonical query, revision binding, evidence identity, inventory summary, reuse decision, budget snapshot, invalidation, diagnostic, and telemetry records under `packages/core/src/code/` and export their public contracts through Core.
- Add a pure canonicalizer that produces the same digest for equivalent field ordering but distinct digests for semantically distinct text, operation, provider, workspace, repository scope, revision, index revision, mode, focus, and filters.
- Extend provider-neutral status with an optional opaque index revision and update mock, disabled, codesearch, and Octocode adapters without exposing provider-specific storage objects.
- Refactor `RepositoryStatePlanner` to emit one semantic-discovery phase first, followed only by unresolved exact-symbol phases. Merge equivalent purposes into one planned query and record evidence requirements and the reason for each additional query.
- Keep the codesearch adapter's provider query normalization, fusion, and reranking behavior intact; this task defines orchestration identity above it.

Out of scope:

- Provider-result caching or ledger migration.
- Changing accepted provider rankings or adding search/index technology.
- Fuzzy equivalence between different natural-language queries.

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
| Implemented Feature Record | `docs/src/features/canonical-retrieval-planning/index.md` | Delivery and audit history |

## Validation Strategy

Equivalent inputs produce one canonical key regardless of array or provider-return ordering.
Different repository, workspace, provider, repository revision, or index revision inputs cannot collide.
Query planning emits no symbol lookup when current evidence already resolves the identifier.
A known path produces a direct-read decision rather than another semantic search.
No provider adapter type or storage detail enters Core domain records.
Validation: Add a focused canonical-query test file covering every key field, normalization edge cases, lower-limit reuse eligibility, and deterministic digests.
Validation: Expand `tests/repository-state-planner.test.ts` for one broad semantic query, exact unresolved identifiers only, merged purposes, known-path suppression, and explicit additional-query reasons.
Validation: Add provider-contract tests proving optional index revisions remain provider-neutral and capability-gated.
Validation: Run the focused domain/planner/provider tests and `mise run typecheck`.

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

Closed Beads feature `atelier-whg`; ATLR-1200 acceptance criteria satisfied; commit a84991f3aad4d0696e5709bea693c138153d98d5.
