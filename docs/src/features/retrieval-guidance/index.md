# Enforce the efficient sequence in Pi and CLI surfaces

## Delivery Summary

- Beads feature root: `atelier-eld`
- Status: delivered
- Closed: 2026-07-27T00:48:13Z
- Design record: [design.md](design.md)

## Delivered Capability

Teach and enforce one semantic discovery, exact resolution only when unresolved, direct reads for known paths, and inventory reuse before additional retrieval.

- Add Pi-extension tests before changing tool behavior for session creation, search reuse, inventory summaries, symbol gating, known-path guidance, budget denial, invalidation, compaction, provider degradation, and raw-scan fallback.
- Start one retrieval session on Pi `session_start`, retain it across agent turns and compaction, and end it on shutdown. Keep Core's non-Pi session API explicit for CLI and tests.
- Update `atlr_code_search`, `atlr_code_symbols`, and `atlr_code_status` descriptions, prompt snippets, structured details, and text output to show the compact inventory, cache/reuse decision, remaining budgets, deduplication, freshness, and truncation.
- Make search guidance require one focused semantic discovery first. Use symbol lookup only for identifiers that the inventory marks unresolved. Require direct built-in `read` for known or returned paths.
- Before another search or symbol call, have the Core decision layer check current evidence. Return reused evidence or an explicit no-provider-call recommendation when the inventory already answers the request.
- Preserve the existing provider-first raw-discovery block. Raw scanning becomes available only for unavailable, unhealthy, stale, degraded, failed, or genuinely empty provider evidence—not for cache hits, budget exhaustion, or agent preference.
- Update `/code-search`, `/code-symbols`, code status, and JSON output to use the same session decisions and diagnostics as agent tools.
- Keep `mise run launch`, background index coordination, configured provider selection, and TUI behavior unchanged.

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
- `docs/src/features/retrieval-guidance/design.md`
- `docs/src/features/retrieval-guidance/index.md`

## Audit Trail

- Beads: `atelier-eld`
- Closure: ATLR-1203 acceptance criteria satisfied; commit da438b6112140910d1518b9c247c31920dd2adae
