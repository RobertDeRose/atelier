# ADR-0043: Make Phase Surfaces Lifecycle-Explicit and Verify UI Evidence Chronologically

## Status

Accepted.

## Date

2026-08-03.

## Context

Pi's `before_agent_start` hook may still report `ctx.isIdle() === true` while the upcoming agent turn is being prepared. Alpha.45 inferred the progress surface from that transient flag, so the planning context phase used Atelier's idle spinner instead of Pi's native working indicator. The guided ledger is newest-first; a pause verifier also selected a later paused footer refresh and reported an 18.953-second delay even though the first paused footer rendered two milliseconds after `execution.paused`.

## Decision

- Let phase callers select `auto`, `spinner`, or `native` explicitly.
- Force `agent.context` to `native` during `before_agent_start`, independent of `ctx.isIdle()`.
- Keep automatic selection for lifecycle-neutral operations and the explicit idle spinner for slash-command work.
- Sort guided control evidence chronologically. Select the latest pause transition, then the earliest paused footer at or after that transition and no later than the corresponding resume transition.
- Propagate embedded verifier exit status before printing a step pass.

## Consequences

- Planning turns use Pi's native Working surface without adding a second spinner row.
- Durable phase evidence reflects lifecycle intent rather than a timing-sensitive idle snapshot.
- Later paused refreshes cannot inflate measured transition latency.
- Guided output cannot report both an objective assertion failure and a pass for the same step.
