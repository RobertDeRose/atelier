# ADR-0017: Plan reads and provider-first code tools

- **Status:** Superseded in part by ADR-0025 and the advisory retrieval policy in 0.14.0-alpha.1
- **Date:** 2026-07-25

## Context

A live Pi planning session requested approval for a command composed only of `find`, `wc`, `rg`, and
`head`. The classifier treated `2>/dev/null` as a file write and treated every pipeline or command
chain as arbitrary execution. The same session used broad raw repository scans because Atelier code
intelligence was available only through user-facing slash commands; the agent had no provider tool it
could call directly.

## Decision

Atelier will classify shell compounds by parsing their unquoted separators and classifying every
segment independently. A compound is read-only only when every segment is read-only. Redirection to
safe sinks such as `/dev/null` and descriptor duplication do not create a write action; ordinary file
redirection and mutating `find` operations remain gated.

The Pi extension will register `atlr_code_status`, `atlr_code_search`, and `atlr_code_symbols` as
agent-callable read-only tools. While plan mode has an enabled provider, broad raw discovery through
`rg`, `grep`, `find`, `fd`, `tree`, or `ls` is rejected until provider search is attempted. Raw fallback
is permitted only when provider evidence is unavailable, unhealthy, degraded, failed, or empty.
Routing rejection is not an approval request.

## Consequences

- Read-only investigation in plan mode proceeds without user approval, including safe pipelines and
  command chains.
- Mutation permission is not broadened: mixed compounds inherit the first mutating classification.
- The model can actually invoke the accepted codesearch path instead of relying on prompt prose or
  user-entered slash commands.
- Exact files returned by the provider should be read directly; broad raw scans become an explicit
  degraded fallback rather than the default discovery mechanism.
- Provider-first routing is reset for each agent turn so the requirement applies to every new planning
  investigation.
