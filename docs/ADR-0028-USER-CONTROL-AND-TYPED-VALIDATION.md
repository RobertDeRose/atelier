# ADR-0028: Preserve user control while tasks remain incomplete

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Atelier 0.14.0-alpha.5 used `agent_settled` to send an incomplete-task message as a Pi `followUp` user
message. A denied shell operation settled the agent, the follow-up immediately started another turn, and
each abort repeated the cycle. The advertised `/cancel` escape also waited for Pi to become idle, while
the completion follow-up prevented Pi from remaining idle.

The same manual run showed that the active task possessed typed validation capabilities but the model had
no typed validation tool. It therefore attempted the declared validation through generic Bash, which
required a separate shell approval. Finally, interruption evidence was inferred from arbitrary error text,
so a normal failed test whose stack mentioned `AbortSignal` was recorded as interrupted.

## Decision

1. The authoritative completion predicate gates task closure only. An incomplete task may remain active
   while the agent is idle or paused.
2. `agent_settled` may emit one passive, deduplicated status notification. It must never enqueue a
   synthetic user message or another model turn.
3. `/cancel` revokes active execution without waiting for idle and may abort the current Pi turn after the
   durable grant is revoked. Cancellation does not close the provider task or alter repository content.
4. Atelier exposes `atlr_validate` as a model-facing typed tool for validation planning, focused execution,
   and explicitly named configured validations. Declared validation must not be routed through Bash.
5. Tool interruption is derived from structured cancellation state or an exact tool-owned terminal
   sentinel, never from general subprocess output words such as `signal`, `abort`, or `cancel`.
6. Authorization does not override the user's latest operational constraints. A request not to validate,
   use Bash, commit, or continue remains binding even when a capability exists.

## Consequences

- The user can deny an operation, press Escape, leave an active task paused, or cancel it without entering
  a forced-continuation loop.
- Task closure remains fail-closed; pausing does not fabricate validation, diff-review, or commit evidence.
- Model validation uses the same declared manifest and capability boundary as CLI and slash-command
  validation.
- Failure and interruption evidence are more trustworthy, but provider-specific tools should expose
  structured cancellation metadata when available.
