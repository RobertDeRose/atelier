# Legacy Decision Record 0027 — Bind exact approval to every workspace repository and retrieval revision

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The original multi-repository workspace gave secondary roots synthetic `unknown` revisions. Plan approval also identified the repository but did not bind the reviewed source or retrieval evidence to a revision.

## Decision

Every trusted workspace root is opened through a real repository provider and contributes a `RepositoryRevisionBinding`. Preparation records the primary source snapshot, all repository bindings, retrieval-provider identities, index revisions, and per-repository revisions. Approval rechecks those bindings immediately before mutation. Resume fails closed when a secondary repository changes; primary changes are accepted only as reachable mutations relative to the approved task baseline.

## Consequences

- Secondary-repository changes invalidate exact execution and cached evidence.
- Approval states exactly which source and retrieval revisions informed the plan.
- Additional workspace roots must be trusted before they can be indexed or bound.
