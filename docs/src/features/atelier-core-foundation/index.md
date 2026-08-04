# Atelier Core Foundation

## Delivery Summary

- Beads feature root: `legacy delivery; predates Beads feature roots`
- Status: delivered
- Closed: pre-dstack
- Design record: [design.md](design.md)

## Delivered Capability

The pre-dstack foundation established Atelier as a local-first workflow control plane with Jujutsu/Git repository observation, provider-neutral code intelligence, durable Working State, workspace recoverability, and Pi integration.

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

Historical implementation and release evidence is preserved in repository history. Current supported behavior is validated by the repository suite and documentation checks.

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
- `docs/src/features/atelier-core-foundation/design.md`
- `docs/src/features/atelier-core-foundation/index.md`

## Audit Trail

- Beads: `legacy delivery; predates Beads feature roots`
- Closure: Migrated from pre-dstack architecture records and historical delivery evidence.
