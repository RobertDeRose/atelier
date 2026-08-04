# Persist mutation and focused-validation evidence in Working State

## Delivery Summary

- Beads feature root: `atelier-h53`
- Status: delivered
- Closed: 2026-07-27T14:11:56Z
- Design record: [design.md](design.md)

## Delivered Capability

Make implementation and validation progress durable, freshness-aware, cancellable, and sufficient for safe resume.

- Write behavior tests first for successful/failed/interrupted tool execution, changed paths, focused selection, no-match behavior, validation cancellation, stale passes, rerun, restart, and task closure gates.
- Add a Core execution-evidence boundary that records tool call ID/name, action classification, execution grant, permission decision/grant, before/after repository snapshots, observed changed paths, result state, and bounded error metadata.
- Use post-execution repository snapshots to distinguish an allowed attempt from an observed mutation; never claim an edit occurred solely because authorization was granted.
- Make `ValidationService.run` asynchronous and abort-aware using direct argument-array process execution, bounded output capture, and durable `passed`, `failed`, or `interrupted` evidence.
- Persist focused-validation selection as evidence with changed paths/symbols, selected names, reasons, plan/task/execution bindings, and the pre-run snapshot.
- Route focused and full-suite categories through independent policy actions. Never promote a no-match focused plan into a full suite.
- Keep conservative freshness: evidence is current only when its snapshot fingerprint equals the present repository fingerprint; expose the newer changed paths/fingerprint as the stale reason.
- Extend Working State and Markdown rendering with workflow checkpoint, approval/reconciliation identity, execution-grant status, execution evidence, selected focused validations, current validation, and stale validation summaries.
- Record validation outcomes against the active task in the ledger. Require current passing evidence for all configured required focused checks before the workflow offers task closure; closure remains an explicit user action through `TaskProvider`.
- After explicit task closure, invalidate the execution grant and expose the next provider-ready approved-plan task without starting it.

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

Every authorized mutating tool result produces durable success/failure/interruption evidence with before/after repository identity.
Focused selection is explainable, runs only configured checks, and persists its result against the active workflow/task.
A pass becomes visibly stale after the next repository fingerprint change and cannot satisfy task closure until rerun.
Interrupted validation is never shown as pass or failure, and cancellation leaves no child process.
A fresh Core/Pi session reconstructs the active task, execution grant, observed changes, validation plan, current/stale evidence, and next action from Working State.
Validation: Expand `tests/validation-service.test.ts` for abort, bounded output, failed/interrupted persistence, no-match, and staleness after source change.
Validation: Extend `tests/reconciliation-state.test.ts` or add a focused Working State test for current/stale validation, execution evidence, grant status, and restart.
Validation: Add policy tests proving focused permission does not imply full-suite or command permission.
Validation: Run focused validation/state/policy tests and `mise run typecheck`.

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
- `docs/src/features/mutation-validation-evidence/design.md`
- `docs/src/features/mutation-validation-evidence/index.md`

## Audit Trail

- Beads: `atelier-h53`
- Closure: ATLR-1103 acceptance criteria satisfied; commit bdf29772ad6fc05bbc6db2a6fc89307b9e59102f
