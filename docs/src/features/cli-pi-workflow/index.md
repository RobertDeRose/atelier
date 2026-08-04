# Unify the CLI and Pi interactive workflow

## Delivery Summary

- Beads feature root: `atelier-cp3`
- Status: delivered
- Closed: 2026-07-27T14:39:01Z
- Design record: [design.md](design.md)

## Delivered Capability

Expose the same safe workflow through commands and Pi hooks, with automatic editor review and an exact user-visible approval sequence.

- Add Pi-extension and CLI integration tests before changing command behavior.
- Refactor `apps/cli/src/main.ts` plan/review/approve/task/validate handlers to use the workflow coordinator rather than independently ordering Core methods.
- Make CLI review print the `ManualEdit` structural diff, diagnostics, and reconciliation preview. Make non-interactive approval require an explicit prepared approval ID/digest plus an affirmative flag; an interactive terminal may confirm the displayed summary.
- Add matching task-start and execution-cancel CLI commands and document their exact usage in help.
- Refactor Pi `/review` and automatic `agent_settled` review to begin/complete the durable `ManualEdit`, then present structural changes and reconciliation readiness without asking the user to restate edits.
- Refactor Pi `/approve` to prepare first, display the exact plan hash, provider, operation counts/details, retirements, and proposed first task, then confirm and execute the bounded transaction.
- Add `/execute [task-id]` for a later ready task and `/cancel` for execution cancellation.
- Add a `tool_result` hook that completes execution evidence, consumes operation grants on every result path, refreshes validation freshness, and updates status. Preserve provider-first `tool_call` routing and code-tool activation unchanged.
- On `session_start`, `before_agent_start`, compaction, and status updates, resume/validate the durable workflow and inject the expanded Working State. Do not treat Pi custom entries or conversation text as authority.
- Make `/validate plan` display focused selections and `/validate focused` request only the required validation permission, pass Pi's abort signal, record evidence, and refresh Working State.
- Keep the current configured-editor resolution and TUI stop/start lifecycle; handle non-TUI editor requests with an actionable recovery message.
- Update `apps/pi-extension/README.md` command/hook documentation in the same task.

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

The initial Pi draft opens in the configured editor automatically and returns a visible `ManualEdit` structural summary.
CLI and Pi cannot approve an unreviewed revision or apply a preview different from the one shown.
One confirmation can move an unchanged, conflict-free reviewed plan through reconciliation and initial task activation; failures stop before act mode.
Agent mutations are denied without both execution and action grants, and every completed tool call refreshes durable evidence.
`/status` and `/state` explain whether the next action is review, resolve conflict, approve, resume reconciliation, execute, validate, close, or select the next task.
Quitting and relaunching Pi neither loses a valid execution nor silently preserves an invalid one.
Validation: Expand `tests/pi-extension.test.ts` with fake Pi lifecycle scenarios for automatic editor review, changed/unchanged plan, approval rejection, exact confirmation, provider conflict, act transition, tool success/failure, validation cancellation, cancel, shutdown, and resume.
Validation: Add CLI child-process integration tests for prepare/approve digest matching, non-interactive safeguards, cancel, focused validation, and JSON stability.
Validation: Retain launcher and provider-first regressions unchanged.
Validation: Run the focused Pi/CLI/launcher tests and `mise run typecheck`.

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
- `docs/src/features/cli-pi-workflow/design.md`
- `docs/src/features/cli-pi-workflow/index.md`

## Audit Trail

- Beads: `atelier-cp3`
- Closure: ATLR-1104 acceptance criteria satisfied; commit c07903cfb7ac79ddf16d256d863b271b4e45ab97
