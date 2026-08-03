# ADR-0039: Pi UI Lifecycle and Durable Presentation Evidence

## Status

Accepted — 2026-08-03

## Context

Atelier's durable workflow state could be correct while the Pi interaction remained ambiguous. Three defects
were confirmed through guided acceptance:

- an authorized model Bash command could produce no visible result and leave Pi's `Working…` indicator active;
- `/plan` and `/approve` could spend several seconds in repository, provider, or reconciliation work before
  showing any visible progress; and
- footer, report, phase, and tool-lifecycle assertions were visible only to the tester and were not represented
  in the evidence archive.

Pi waits for extension tool-result handlers before it can finalize a tool row and settle the agent. Starting a
full repository/footer observation from that handler extended the tool-completion critical path. Atelier's former
model Bash wrapper also depended on child-process `close`; a short-lived shell can exit while a detached
descendant keeps inherited stdout or stderr open, leaving the tool promise unsettled.

## Decision

Atelier owns an explicit Pi presentation lifecycle:

1. The policy-controlled model Bash tool owns start, streamed update, final result, interruption, and failure
   states. It returns a final result on success, throws on failure/interruption as required by Pi, and records bounded output metrics and hashes.
2. The bounded process runner completes after the parent exits and output falls idle for a short grace period,
   even when a detached descendant retains inherited pipes. Timeout and abort paths retain process-group
   `SIGTERM`/`SIGKILL` escalation.
3. Pi `tool_result` handlers complete durable mutation evidence but do not await repository or footer refreshes.
   `agent_settled` owns the post-turn footer observation, allowing Pi to finalize the tool row and clear its
   working indicator first.
4. Slash-command and approval work installs an inline footer status and Pi working message, then yields one
   event-loop turn before expensive work begins. Transient phase text does not use an above-editor widget.
   `/plan` keeps its phase until the agent starts;
   `/approve` exposes provider, preparation, revalidation, reconciliation, convergence, activation, and final
   status phases.
5. Atelier persists bounded diagnostic presentation events for reports, footer renders, phase transitions,
   model Bash lifecycle, direct-shell denials, and agent settlement. Raw model Bash output is not persisted;
   only byte counts, truncation state, and SHA-256 evidence are stored.
6. The guided verifier uses these events as objective evidence. Visual behavior is no longer accepted solely
   from a tester note when a durable representation is practical.

Presentation evidence is diagnostic and cannot grant authority, satisfy validation, or close a task. Failure to
record late presentation evidence never fails the underlying user operation.

## Consequences

- Authorized model Bash output reaches Pi through both streamed updates and a final success result; failure/interruption is thrown into Pi’s normal error-finalization path, so every tool invocation settles explicitly.
- Repository/provider refreshes no longer delay tool-row completion or keep Pi's working state active.
- `/plan`, `/approve`, `/status`, and `/workflow` expose visible progress before blocking I/O.
- Guided evidence can verify distinct report bodies, footer state transitions, approval phases, model Bash
  output/completion, and the final idle state.
- The ledger grows by bounded diagnostic events. Report/footer text is size-limited and passes through Atelier's
  existing redaction layer; shell output is represented only by hashes and metrics.
- Changes to Pi's tool or UI lifecycle contracts require updates to the model Bash and presentation-evidence
  regressions.
