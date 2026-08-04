# Design — Orchestrate session reuse, deduplication, and request budgets

## Metadata

- Beads feature root: `atelier-uvu`
- Feature slug: `retrieval-session-orchestration`
- Design path: `docs/src/features/retrieval-session-orchestration/design.md`
- Implemented record: `docs/src/features/retrieval-session-orchestration/index.md`
- Status: delivered

## Feature Summary

Make `CodeService` converge repeated and overlapping retrieval into one bounded session evidence inventory before results reach the model.

In scope:

- Write behavior-driven service tests first for exact cache hits, greater-limit to smaller-limit reuse, incomplete-result rejection, safe covered overlap, known-path direct-read decisions, provider drift, repository drift, index drift, degraded results, errors, and request exhaustion. Durable reopen behavior belongs to ATLR-1202.
- Add a provider-neutral retrieval-session orchestrator owned by `CodeService`; route search, symbols, relationships, and fetch accounting through it without moving parsing, indexing, or provider-native reranking into Core.
- Before a provider call, compare the canonical request with current inventory, verify repository and index bindings, and return an explicit provider-call, exact-reuse, overlap-reuse, direct-read, invalidated, unsupported, or budget-denied decision.
- Deduplicate paths, symbols, chunks, and references across all requests before constructing the model-facing result. Merge retrieval methods and provenance observations while preserving the original provider provenance on every item.
- Count repeated paths once against the unique-path budget. Keep separately bounded evidence-entry and byte budgets so multiple chunks cannot grow without limit.
- Enforce configurable per-session provider-request and result budgets in Atelier for every provider, including symbols and relationships. Keep capability checks and Octocode's optional behavior unchanged.
- Replace mutable lifetime-only fetch counters with session counters and make truncation deterministic and diagnostic.
- Emit structured telemetry for provider calls, cache hits, overlap reuse, unique paths, duplicates removed by identity class, returned bytes, remaining budget, invalidations, and truncation.

Out of scope:

- SQLite schema or Pi prompt changes.
- Cross-session semantic cache reuse.
- Reordering provider-native candidates before existing Atelier focus/reranking logic runs.

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

| Documentation concern      | Exact page                                                   | Change                     |
|----------------------------|--------------------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`                          | Current supported behavior |
| Development                | `docs/src/development/setup.md`                              | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                                        | Feature registration       |
| Implemented Feature Record | `docs/src/features/retrieval-session-orchestration/index.md` | Delivery and audit history |

## Validation Strategy

An unchanged exact query converges after one provider call, including repeated Working State builds.
Duplicate references are removed before evidence reaches the model, and repeated paths consume one unique-path slot.
Reused evidence retains original provider provenance plus an Atelier reuse observation.
Stale, partial, degraded, differently scoped, or lower-limit evidence is never represented as a complete current cache hit.
Request exhaustion fails with an actionable diagnostic and does not silently fall back to raw scanning.
Validation: Expand `tests/code-budgets.test.ts` into BDD scenarios for all request/result/fetch/path/entry/byte boundaries.
Validation: Add instrumented fake-provider tests asserting no equivalent canonical query reaches the provider twice at the same repository and index revisions.
Validation: Add multi-repository tests proving scoped cache hits return only requested repository evidence and cannot leak from another workspace.
Validation: Add invalidation tests proving repository or index changes prevent cached evidence from being reported as current.
Validation: Run focused service/budget/provider tests and `mise run typecheck`.

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

Closed Beads feature `atelier-uvu`; ATLR-1201 acceptance criteria satisfied; commit 485a1634a5027cd3ebb28b58ae01b42d8a291672.
