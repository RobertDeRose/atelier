# ADR-0018: Default approved repository execution

Status: accepted

## Context

A live Atelier-on-Atelier implementation run requested approval for every edit,
write, validation command, and local repository operation. The user denied the
full-suite prompt, so the agent stopped with a validated but uncommitted
implementation. Operation-scoped grants made an approved plan practically
unusable and did not improve safety for ordinary task work.

## Decision

Policy classifies operations as:

- `routine`: expected local implementation work;
- `destructive`: operations that discard or rewrite state;
- `external`: network, publication, or other non-local effects;
- `unknown`: commands Atelier cannot classify confidently.

In act mode, routine operations are allowed without another prompt when explicit
paths remain inside the active repository. This includes ordinary edits and
writes, declared validation tasks, task-provider updates, dependency work, and
local Git/Jujutsu commits.

Atelier still requires explicit approval for destructive, external, unknown,
publication, and out-of-repository operations. Plan-mode mutation restrictions
are unchanged.

When an agent settles in act mode with a selected task and uncommitted repository
changes, Atelier sends one follow-up per dirty fingerprint requiring validation,
final diff inspection, and a local commit before reporting completion.

## Consequences

Plan approval becomes the meaningful authorization boundary for routine local
execution. Fine-grained grants remain available for exceptional operations.
Atelier does not automatically commit user changes; the agent must inspect and
create the task-scoped local commit.
