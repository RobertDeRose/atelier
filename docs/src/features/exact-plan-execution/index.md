# Enforce exact approval and task-scoped execution grants

## Delivery Summary

- Beads feature root: `atelier-s4d`
- Status: delivered
- Closed: 2026-07-27T13:25:41Z
- Design record: [design.md](design.md)

## Delivered Capability

Move from a reviewed plan to act mode only through one exact, inspectable approval transaction followed by successful reconciliation and task activation.

- Add failing-first workflow tests for approval rejection, hash drift, provider drift, partial reconciliation, unavailable provider, no ready task, task claim failure, grant invalidation, cancellation, and restart.
- Introduce a Core workflow coordinator (for example under `packages/core/src/workflow/`) with explicit prepare, approve/apply, start-task, cancel, and resume operations used by both clients.
- Define typed `PlanApproval`, `ReconciliationTransaction`, and `ExecutionGrant` records with the bindings and lifecycle described above.
- Persist execution grants and their invalidation reason in the ledger; bind execution-time `PermissionGrant` records to an active execution grant where applicable.
- Change `PolicyEngine` inputs so act-mode agent mutations require both a valid execution grant for the request task/workspace and the independently required permission grant. Reads remain approval-free.
- Recompute the plan hash and reconciliation digest immediately before mutation. Apply the approved reconciliation, re-preview, select an approved-plan ready task, claim it through `TaskProvider`, and only then set act mode/current task and issue the execution grant.
- Make task-provider initialization a separately confirmed preparation step and keep plan mode's general prohibition on arbitrary task mutation intact.
- Add task-start behavior for a later ready task after the previous execution grant ends; require explicit confirmation while reusing the unchanged plan approval.
- Add cancellation that revokes execution-linked permissions without reverting source or altering provider task status.
- Fail closed on resume when any grant binding is invalid, while preserving enough checkpoint detail to retry safely.

## User-Facing Behavior

The feature is available through the current shared Core workflow and its supported CLI and Pi integrations where applicable.

## Design Integration

The implementation uses Atelier's typed Core and durable evidence boundaries. It does not make a client, code provider, or task provider authoritative for approval, repository state, validation, recovery, or closure.

## Operational Impact

Use the current [architecture overview](../../architecture/overview.md), [user guide](../../user-guide/index.md), and [development guide](../../development/setup.md) for supported behavior and procedures.

## Reference and Contracts

- [Plan format](plan-format.md)
- [Code intelligence](../../features/canonical-retrieval-planning/code-intelligence/index.md)
- [Feature lifecycle](../../development/workflow-commands.md)

## Validation Evidence

No task-provider operation occurs before approval of the exact displayed hash/digest, except separately confirmed provider initialization.
Rejection, changed plan/provider state, conflicts, or partial failure cannot create act mode or an execution grant.
Successful transition leaves an applied reconciliation, a claimed approved-plan task, act mode, and one valid task-scoped execution grant in durable state.
The grant conveys no action permission and is invalidated under every condition listed in this plan.
Cancellation and restart are deterministic, auditable, and never revert repository content.
Validation: Extend `tests/policy-engine.test.ts` for the two-key rule: execution authorization plus action permission.
Validation: Add coordinator integration tests with in-memory and failing providers for exact confirmation and all invalidation conditions.
Validation: Verify one-operation permissions are revoked after success, failure, and interruption.
Validation: Verify restart preserves a still-valid task-scoped execution grant and rejects a stale plan/provider/workspace binding.
Validation: Run focused policy/workflow tests and `mise run typecheck`.

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
- `docs/src/features/exact-plan-execution/design.md`
- `docs/src/features/exact-plan-execution/index.md`

## Audit Trail

- Beads: `atelier-s4d`
- Closure: ATLR-1102 acceptance criteria satisfied; commit f3b8904c63f5ca612b377e15abc370060c451dfc
