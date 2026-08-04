# Reconcile the complete approved task projection safely

## Delivery Summary

- Beads feature root: `atelier-8xk`
- Status: delivered
- Closed: 2026-07-27T12:47:51Z
- Design record: [design.md](design.md)

## Delivered Capability

Produce a provider-neutral, canonical, idempotent projection of the reviewed plan, including dependency removals and explicit retirement, that can recover from interruption without duplicate tasks.

- Write reconciliation behavior tests first for create/adopt/update/link/unlink/retire, reordering, repeated preview/apply, partial failure, restart, ambiguous identity, and provider drift.
- Extend `ReconciliationOperation` and `TaskReconciliation` with normalized field changes, unlink, retire, adopt, deterministic operation IDs, provider identity, and a canonical reconciliation digest.
- Extend `TaskProvider` only with provider-neutral capabilities required by the operations, including safe dependency removal or explicit capability reporting. Keep every Beads command inside `BeadsCliTaskProvider`.
- Make the stable plan marker (`planTaskId`) round-trip through in-memory and Beads records so a restart can adopt exactly one externally created task if a crash occurred before `plan_task_mappings` was stored.
- Compare plan mappings with provider state to preview tasks removed from the plan as retirements and dependencies removed from the plan as unlinks. Never delete provider tasks.
- Update every surviving mapping to the newly reconciled plan hash, including reorder-only revisions that require no provider mutation.
- Record started/completed/failed operation checkpoints and make apply resume by inspecting provider state rather than blindly replaying writes.
- Surface unsupported provider behavior, disappeared records, reused stable IDs, multiple stable-marker matches, cycles, and unexpected provider edits as conflicts.
- Preserve plan-order tie-breaking in `WorkingStateBuilder` and all existing provider-outage degradation for read-only state construction.

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

Preview precisely describes creates, adoptions, updates, links, unlinks, retirements, no-ops, and conflicts for the reviewed hash.
Equivalent inputs produce the same digest and operation IDs regardless of provider return ordering.
Applying or resuming an unchanged preview converges exactly once and a subsequent preview is empty.
A crash after provider create but before mapping storage cannot create a duplicate; ambiguous matches block safely.
Removed provider tasks are closed only as an operation visible in the explicitly approved preview, and removed dependencies are not silently retained.
Core and Working State remain unaware of Beads command/storage details.
Validation: Expand `tests/reconciliation-state.test.ts` with BDD scenarios for every operation and crash boundary, including no duplicate create after reopen.
Validation: Expand `tests/beads-cli-provider.test.ts` and in-memory provider tests to cover stable markers, unlink, retirement, and argument-array invocation with shell metacharacters.
Validation: Add a provider conformance fixture shared by in-memory and fake-Beads adapters.
Validation: Run focused reconciliation/provider tests and `mise run typecheck`.
Validation: If the pinned `bd` executable is available, run a disposable-repository live conformance for create, dependency add/remove, update, close, and ready; do not make the ordinary suite depend on it.

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
- `docs/src/features/task-reconciliation/design.md`
- `docs/src/features/task-reconciliation/index.md`

## Audit Trail

- Beads: `atelier-8xk`
- Closure: ATLR-1101 acceptance criteria satisfied; commit a1840ff4d3404ca2711fa5a3dce72994efad2bdf
