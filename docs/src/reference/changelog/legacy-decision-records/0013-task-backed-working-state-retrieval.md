# Legacy Decision Record 0013 — Build Repository Evidence from Durable Workflow State

- Status: Accepted
- Date: 2026-07-23

## Context

Atelier already injected Working State into Pi before agent turns, but repository retrieval depended
on an active provider task. During planning there is normally no task yet, so the agent entered plan
mode without repository evidence derived from the user's objective. Working State also omitted
direct dependency records, blockers, and ManualEdit evidence, and ready-task selection could expose
unrelated provider work even after a plan was approved.

## Decision

Persist the normalized planning objective as durable Atelier state and introduce a deterministic
Repository State Planner. The planner emits at most two bounded provider queries from:

1. the durable planning objective and reviewed plan while in plan mode; or
2. the active provider task and reviewed task scope while in act mode.

Exact identifier hints are extracted only from quoted or code-shaped terms. External providers remain
authoritative for indexing and ranking. Atelier owns query selection, budgets, deduplication,
provenance, degradation reporting, and Working State projection.

Task selection uses this deterministic order:

1. explicitly selected task;
2. resumable current task;
3. highest-priority provider-ready task within the approved plan;
4. reviewed-plan order;
5. stable provider task ID.

Working State includes direct dependencies, non-closed blockers, durable corrections and findings,
recent relevant Manual Edits, validation evidence, retrieval queries, and normalized code evidence.
Transient provider failures never clear the durable current-task pointer.

## Consequences

- Planning and review begin with repository evidence before task reconciliation.
- Unrelated provider tasks are excluded from approved-plan Working State.
- Task-selection rationale is inspectable in both Working State and the ledger.
- Consumers of Working State JSON must accept the expanded schema.
- Retrieval remains bounded and provider-neutral; Atelier does not add a native code index.
