# Persist a bounded evidence inventory in Working State

## Delivery Summary

- Beads feature root: `atelier-14h`
- Status: delivered
- Closed: 2026-07-27T00:17:22Z
- Design record: [design.md](design.md)

## Delivered Capability

Make retrieval reuse and diagnostics survive agent turns and compaction while remaining bounded, freshness-aware, and subordinate to Working State.

- Write migration and integration tests first for save/reopen, atomic result/checkpoint persistence, bounded pruning, invalidation, unknown freshness, corrupted or disappeared evidence, and databases created before this feature.
- Add a ledger migration for retrieval sessions, canonical request records, compact evidence records, provenance observations, counters, and invalidation diagnostics. Persist no full fetched source chunks and no unrestricted query output.
- Save provider results and their query checkpoint atomically. Never persist a successful cache record for a failed or interrupted provider call.
- Bound storage by configurable retained-session count, entry count, and serialized bytes; prune oldest inactive sessions deterministically and preserve current-session records required by Working State.
- Extend `AtelierConfig`, config initialization, validation, CLI configuration output, and defaults with provider-request, unique-path, compact-entry, retained-session, persisted-entry, and persisted-byte budgets.
- Extend `WorkingState` and Markdown rendering with the current retrieval session, compact evidence inventory, freshness/revision bindings, request and result budgets, provider/cache counters, deduplication counts, bytes, truncation, invalidations, and additional-query decisions.
- Make `WorkingStateBuilder` consult session inventory before executing the phased repository plan. Repeated builds must reuse valid evidence, avoid duplicate path budget consumption, and preserve existing task-provider outage degradation.
- Extend `code.search_completed` diagnostics rather than creating unbounded per-hit events; report enough aggregate fields to audit provider calls and reuse.

## User-Facing Behavior

The feature is available through the current shared Core workflow and its supported CLI and Pi integrations where applicable.

## Design Integration

The implementation uses Atelier's typed Core and durable evidence boundaries. It does not make a client, code provider, or task provider authoritative for approval, repository state, validation, recovery, or closure.

## Operational Impact

Use the current [architecture overview](../../architecture/overview.md), [user guide](../../user-guide/index.md), and [development guide](../../development/setup.md) for supported behavior and procedures.

## Reference and Contracts

- [Plan format](../../features/exact-plan-execution/plan-format.md)
- [Code intelligence](../../features/canonical-retrieval-planning/code-intelligence/index.md)
- [Feature lifecycle](../../development/workflow-commands.md)

## Validation Evidence

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

## Design Reconciliation

### Delivered as Designed

The closed Beads feature records that the stated acceptance criteria were satisfied.

### Intentional Changes

No post-delivery divergence is recorded in Beads.

### Deferred Work

Future enhancements remain separate Beads work.

### Rejected or Removed Scope

No removed scope is represented as current supported behavior.

## Documentation Updated

- `docs/src/SUMMARY.md`
- `docs/src/features/durable-retrieval-inventory/design.md`
- `docs/src/features/durable-retrieval-inventory/index.md`

## Audit Trail

- Beads: `atelier-14h`
- Closure: ATLR-1202 acceptance criteria satisfied; commit b8daff238b40a616545e8b11e98e7a5a370ec5ba
