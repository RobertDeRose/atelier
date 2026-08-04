# Legacy Decision Record 0026 — Use one authoritative task-completion predicate

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

A settlement reminder could be ignored and did not prove validation, final-diff review, a local change, or clean repository state. Task closure and agent settlement could therefore disagree about whether work was complete.

## Decision

Atelier computes one durable `TaskClosureReadiness` result. Closure requires all configured required validations to be current and passing, an exact final-diff review against the approved baseline, a local finalized change or commit, and repository cleanliness when required by policy. A closure policy that requires validation is invalid unless at least one validation is marked required.

CLI closure, Pi closure, Working State, status, and agent-settlement guidance use this predicate. External task closure before the predicate passes invalidates the execution grant.

## Consequences

- Completion language is evidence-backed rather than advisory.
- A changed diff invalidates the prior review.
- Empty or all-optional validation selection cannot silently satisfy a required-validation policy.
