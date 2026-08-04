# Persist reviewed revisions and complete ManualEdit evidence

## Delivery Summary

- Beads feature root: `atelier-cu0`
- Status: delivered
- Closed: 2026-07-26T18:26:06Z
- Design record: [design.md](design.md)

## Delivered Capability

Make direct plan editing a durable, restart-safe transaction whose complete structural result is the sole input to reconciliation.

- Add behavior-first unit and integration scenarios before implementation for unchanged review, field edits, additions, removals, reordering, invalid plans, editor failure, concurrent source drift, and restart.
- Add typed workflow/review records in `packages/core/src/domain/types.ts`, including a durable workflow run/checkpoint and `ManualEdit` lifecycle (`started`, `completed`, `interrupted`, `failed`).
- Add a ledger migration and transactional helpers in `packages/core/src/ledger/sqlite-ledger.ts` so the current workflow checkpoint and its event are updated atomically and remain compatible with existing databases.
- Extract a reusable structural diff under `packages/core/src/planning/` that compares plan order and every parsed task field: ID, title, goal/description, scope, exclusions, dependencies, validation, completion criteria, notes, priority, and type.
- Replace the ad hoc `AtelierCore.recordPlanReview` path with begin/complete/cancel review operations that capture editor metadata, plan path, before/after content hashes, before/after repository snapshots, changed path, diagnostics, structural diff, and ambiguity/drift status.
- Keep full plan content in the plan file; store hashes and bounded structural evidence rather than duplicating unrestricted document text in ledger payloads.
- Preserve `ensurePlanDocument`, configured-editor precedence, and the existing Pi TUI suspension boundary.
- Export the new types/service through `packages/core/src/index.ts` and update `docs/PLAN_FORMAT.md` only where the canonical structural fields need clarification.

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

A saved direct edit produces one completed `ManualEdit` with deterministic added, removed, reordered, and field-changed details.
An unchanged editor session is still valid review evidence but is reported as textually unchanged.
Blocking diagnostics, editor interruption, plan deletion, or concurrent source drift cannot advance the reviewed-plan checkpoint.
Restart reconstructs the pending/completed review without relying on Pi session messages.
Existing databases migrate in place; the pre-existing `.atelier/PLAN.md` and task/provider state are not deleted or rewritten implicitly.
Validation: Add focused tests in `tests/plan-parser.test.ts` and a new workflow/review test covering all structural fields and deterministic ordering.
Validation: Extend `tests/core.integration.test.ts` to close/reopen Core between review start and completion and verify durable recovery.
Validation: Add editor failure, deletion, unchanged review, and concurrent repository-drift cases without launching a real interactive editor.
Validation: Run the focused Node test files and `mise run typecheck`.

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
- `docs/src/features/reviewed-plan-evidence/design.md`
- `docs/src/features/reviewed-plan-evidence/index.md`

## Audit Trail

- Beads: `atelier-cu0`
- Closure: ATLR-1100 acceptance criteria satisfied; implementation 1a34b6a and validation-contract fix 57f5f24e25f615defa4110c875d8de828c8a244a
