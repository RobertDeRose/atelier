# Design — Persist a bounded evidence inventory in Working State

## Metadata

- Beads feature root: `atelier-14h`
- Feature slug: `durable-retrieval-inventory`
- Design path: `docs/src/features/durable-retrieval-inventory/design.md`
- Implemented record: `docs/src/features/durable-retrieval-inventory/index.md`
- Status: delivered

## Feature Summary

Make retrieval reuse and diagnostics survive agent turns and compaction while remaining bounded, freshness-aware, and subordinate to Working State.

In scope:

- Write migration and integration tests first for save/reopen, atomic result/checkpoint persistence, bounded pruning, invalidation, unknown freshness, corrupted or disappeared evidence, and databases created before this feature.
- Add a ledger migration for retrieval sessions, canonical request records, compact evidence records, provenance observations, counters, and invalidation diagnostics. Persist no full fetched source chunks and no unrestricted query output.
- Save provider results and their query checkpoint atomically. Never persist a successful cache record for a failed or interrupted provider call.
- Bound storage by configurable retained-session count, entry count, and serialized bytes; prune oldest inactive sessions deterministically and preserve current-session records required by Working State.
- Extend `AtelierConfig`, config initialization, validation, CLI configuration output, and defaults with provider-request, unique-path, compact-entry, retained-session, persisted-entry, and persisted-byte budgets.
- Extend `WorkingState` and Markdown rendering with the current retrieval session, compact evidence inventory, freshness/revision bindings, request and result budgets, provider/cache counters, deduplication counts, bytes, truncation, invalidations, and additional-query decisions.
- Make `WorkingStateBuilder` consult session inventory before executing the phased repository plan. Repeated builds must reuse valid evidence, avoid duplicate path budget consumption, and preserve existing task-provider outage degradation.
- Extend `code.search_completed` diagnostics rather than creating unbounded per-hit events; report enough aggregate fields to audit provider calls and reuse.

Out of scope:

- Using the retrieval ledger as a source-code cache.
- Treating conversational summaries as evidence authority.
- Weakening current task, permission, ManualEdit, or validation projections.

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

| Documentation concern      | Exact page                                               | Change                     |
|----------------------------|----------------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`                      | Current supported behavior |
| Development                | `docs/src/development/setup.md`                          | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                                    | Feature registration       |
| Implemented Feature Record | `docs/src/features/durable-retrieval-inventory/index.md` | Delivery and audit history |

## Validation Strategy

Working State can explain the current evidence inventory and every provider-call/reuse decision without conversation history.
A fresh Core instance using the same active retrieval session reconstructs valid bounded evidence and counters.
New Pi sessions do not silently reuse old-session evidence as current, and deterministic pruning keeps storage within configured limits.
Telemetry reports provider calls, cache hits, unique paths, duplicate results removed, bytes returned, and truncation.
Existing databases migrate in place without altering plan, task-provider, validation, permission, or ManualEdit state.
Validation: Add ledger migration tests that reopen a pre-feature database and verify bounded records and atomic rollback.
Validation: Expand Working State integration tests for repeated builds, compaction reconstruction, cache telemetry, duplicate path suppression, repository/index invalidation, provider outage, and multi-repository scope isolation.
Validation: Add configuration tests for defaults, overrides, impossible combinations, and positive bounded values.
Validation: Verify cached or reused evidence is omitted or marked non-current immediately after affected repository or index revision changes.
Validation: Run focused ledger/configuration/Working State tests and `mise run typecheck`.

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

Closed Beads feature `atelier-14h`; ATLR-1202 acceptance criteria satisfied; commit b8daff238b40a616545e8b11e98e7a5a370ec5ba.
