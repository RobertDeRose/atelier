# Design — Enforce the efficient sequence in Pi and CLI surfaces

## Metadata

- Beads feature root: `atelier-eld`
- Feature slug: `retrieval-guidance`
- Design path: `docs/src/features/retrieval-guidance/design.md`
- Implemented record: `docs/src/features/retrieval-guidance/index.md`
- Status: delivered

## Feature Summary

Teach and enforce one semantic discovery, exact resolution only when unresolved, direct reads for known paths, and inventory reuse before additional retrieval.

In scope:

- Add Pi-extension tests before changing tool behavior for session creation, search reuse, inventory summaries, symbol gating, known-path guidance, budget denial, invalidation, compaction, provider degradation, and raw-scan fallback.
- Start one retrieval session on Pi `session_start`, retain it across agent turns and compaction, and end it on shutdown. Keep Core's non-Pi session API explicit for CLI and tests.
- Update `atlr_code_search`, `atlr_code_symbols`, and `atlr_code_status` descriptions, prompt snippets, structured details, and text output to show the compact inventory, cache/reuse decision, remaining budgets, deduplication, freshness, and truncation.
- Make search guidance require one focused semantic discovery first. Use symbol lookup only for identifiers that the inventory marks unresolved. Require direct built-in `read` for known or returned paths.
- Before another search or symbol call, have the Core decision layer check current evidence. Return reused evidence or an explicit no-provider-call recommendation when the inventory already answers the request.
- Preserve the existing provider-first raw-discovery block. Raw scanning becomes available only for unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence—not for cache hits, budget exhaustion, or agent preference.
- Update `/code-search`, `/code-symbols`, code status, and JSON output to use the same session decisions and diagnostics as agent tools.
- Keep `mise run launch`, background index coordination, configured provider selection, and TUI behavior unchanged.

Out of scope:

- A new TUI panel or fourth agent retrieval tool.
- Automatic raw scanning after a request-budget denial.
- Provider-specific branches in Pi or CLI.

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

| Documentation concern      | Exact page                                      | Change                     |
|----------------------------|-------------------------------------------------|----------------------------|
| Architecture               | `docs/src/architecture/overview.md`             | Current supported behavior |
| Development                | `docs/src/development/setup.md`                 | Current developer guidance |
| Navigation                 | `docs/src/SUMMARY.md`                           | Feature registration       |
| Implemented Feature Record | `docs/src/features/retrieval-guidance/index.md` | Delivery and audit history |

## Validation Strategy

The agent-visible sequence no longer relies on voluntary conversational memory; Atelier checks evidence before dispatching another provider request.
Equivalent normalized requests at one provider/repository/index revision never reach the provider twice in a session.
Known paths produce direct-read guidance, and unresolved symbols are the only reason for symbol lookup.
Multi-repository scope and original provenance are visible in every fresh or reused result.
The behavior is available through the supported `mise run launch` entry point.
Validation: Expand `tests/pi-extension.test.ts` with an instrumented provider and repeated agent-tool calls; assert the second equivalent query makes no provider call.
Validation: Test one broad semantic call followed by only unresolved exact-symbol calls, then direct reads of returned paths.
Validation: Test that every code-tool response and injected Working State exposes an inventory without requiring another tool call.
Validation: Add CLI JSON stability tests for decision, telemetry, provenance, scope, invalidation, and truncation fields.
Validation: Retain provider-first, background-index, outage, launcher, and shell-metacharacter regressions.
Validation: Run focused Pi/CLI/launcher tests and `mise run typecheck`.

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

Closed Beads feature `atelier-eld`; ATLR-1203 acceptance criteria satisfied; commit da438b6112140910d1518b9c247c31920dd2adae.
