# Design — Unify the CLI and Pi interactive workflow

## Metadata

- Beads feature root: `atelier-cp3`
- Feature slug: `cli-pi-workflow`
- Design path: `docs/src/features/cli-pi-workflow/design.md`
- Implemented record: `docs/src/features/cli-pi-workflow/index.md`
- Status: delivered

## Feature Summary

Expose the same safe workflow through commands and Pi hooks, with automatic editor review and an exact user-visible approval sequence.

In scope:

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

Out of scope:

- New custom TUI components, overlays, keybindings, or replacement editors.
- Changing the accepted codesearch provider or broad-discovery routing.
- Hiding provider conflicts or auto-confirming any approval.

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

| Documentation concern      | Exact page                                   | Change                     |
|----------------------------|----------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`          | Current supported behavior |
| Development                | `docs/src/development/setup.md`              | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                        | Feature registration       |
| Implemented Feature Record | `docs/src/features/cli-pi-workflow/index.md` | Delivery and audit history |

## Validation Strategy

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

Closed Beads feature `atelier-cp3`; ATLR-1104 acceptance criteria satisfied; commit c07903cfb7ac79ddf16d256d863b271b4e45ab97.
