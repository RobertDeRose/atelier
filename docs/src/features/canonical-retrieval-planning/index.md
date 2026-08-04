# Define canonical retrieval identity and phased query plans

## Delivery Summary

- Beads feature root: `atelier-whg`
- Status: delivered
- Closed: 2026-07-26T21:59:17Z
- Design record: [design.md](design.md)

## Delivered Capability

Create provider-neutral domain contracts that distinguish broad semantic discovery from exact symbol resolution and make safe reuse decisions deterministic.

- Write unit tests first for conservative text normalization, sorted scope filters, operation-specific keys, requested-limit handling, Jujutsu/Git revision vectors, provider/index identity, and multi-repository isolation.
- Add typed retrieval session, canonical query, revision binding, evidence identity, inventory summary, reuse decision, budget snapshot, invalidation, diagnostic, and telemetry records under `packages/core/src/code/` and export their public contracts through Core.
- Add a pure canonicalizer that produces the same digest for equivalent field ordering but distinct digests for semantically distinct text, operation, provider, workspace, repository scope, revision, index revision, mode, focus, and filters.
- Extend provider-neutral status with an optional opaque index revision and update mock, disabled, codesearch, and Octocode adapters without exposing provider-specific storage objects.
- Refactor `RepositoryStatePlanner` to emit one semantic-discovery phase first, followed only by unresolved exact-symbol phases. Merge equivalent purposes into one planned query and record evidence requirements and the reason for each additional query.
- Keep the codesearch adapter's provider query normalization, fusion, and reranking behavior intact; this task defines orchestration identity above it.

## User-Facing Behavior

The feature is available through the current shared Core workflow and its supported CLI and Pi integrations where applicable.

## Design Integration

The implementation uses Atelier's typed Core and durable evidence boundaries. It does not make a client, code provider, or task provider authoritative for approval, repository state, validation, recovery, or closure.

## Operational Impact

Use the current [architecture overview](../../architecture/overview.md), [user guide](../../user-guide/index.md), and [development guide](../../development/setup.md) for supported behavior and procedures.

## Reference and Contracts

- [Plan format](../exact-plan-execution/plan-format.md)
- [Code Intelligence and Retrieval](code-intelligence/index.md)
- [Feature lifecycle](../../development/workflow-commands.md)

## Validation Evidence

Equivalent inputs produce one canonical key regardless of array or provider-return ordering.
Different repository, workspace, provider, repository revision, or index revision inputs cannot collide.
Query planning emits no symbol lookup when current evidence already resolves the identifier.
A known path produces a direct-read decision rather than another semantic search.
No provider adapter type or storage detail enters Core domain records.
Validation: Add a focused canonical-query test file covering every key field, normalization edge cases, lower-limit reuse eligibility, and deterministic digests.
Validation: Expand `tests/repository-state-planner.test.ts` for one broad semantic query, exact unresolved identifiers only, merged purposes, known-path suppression, and explicit additional-query reasons.
Validation: Add provider-contract tests proving optional index revisions remain provider-neutral and capability-gated.
Validation: Run the focused domain/planner/provider tests and `mise run typecheck`.

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
- `docs/src/features/canonical-retrieval-planning/design.md`
- `docs/src/features/canonical-retrieval-planning/index.md`

## Audit Trail

- Beads: `atelier-whg`
- Closure: ATLR-1200 acceptance criteria satisfied; commit a84991f3aad4d0696e5709bea693c138153d98d5
