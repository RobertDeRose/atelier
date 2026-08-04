# Orchestrate session reuse, deduplication, and request budgets

## Delivery Summary

- Beads feature root: `atelier-uvu`
- Status: delivered
- Closed: 2026-07-26T23:22:44Z
- Design record: [design.md](design.md)

## Delivered Capability

Make `CodeService` converge repeated and overlapping retrieval into one bounded session evidence inventory before results reach the model.

- Write behavior-driven service tests first for exact cache hits, greater-limit to smaller-limit reuse, incomplete-result rejection, safe covered overlap, known-path direct-read decisions, provider drift, repository drift, index drift, degraded results, errors, and request exhaustion. Durable reopen behavior belongs to ATLR-1202.
- Add a provider-neutral retrieval-session orchestrator owned by `CodeService`; route search, symbols, relationships, and fetch accounting through it without moving parsing, indexing, or provider-native reranking into Core.
- Before a provider call, compare the canonical request with current inventory, verify repository and index bindings, and return an explicit provider-call, exact-reuse, overlap-reuse, direct-read, invalidated, unsupported, or budget-denied decision.
- Deduplicate paths, symbols, chunks, and references across all requests before constructing the model-facing result. Merge retrieval methods and provenance observations while preserving the original provider provenance on every item.
- Count repeated paths once against the unique-path budget. Keep separately bounded evidence-entry and byte budgets so multiple chunks cannot grow without limit.
- Enforce configurable per-session provider-request and result budgets in Atelier for every provider, including symbols and relationships. Keep capability checks and Octocode's optional behavior unchanged.
- Replace mutable lifetime-only fetch counters with session counters and make truncation deterministic and diagnostic.
- Emit structured telemetry for provider calls, cache hits, overlap reuse, unique paths, duplicates removed by identity class, returned bytes, remaining budget, invalidations, and truncation.

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
- `docs/src/features/retrieval-session-orchestration/design.md`
- `docs/src/features/retrieval-session-orchestration/index.md`

## Audit Trail

- Beads: `atelier-uvu`
- Closure: ATLR-1201 acceptance criteria satisfied; commit 485a1634a5027cd3ebb28b58ae01b42d8a291672
