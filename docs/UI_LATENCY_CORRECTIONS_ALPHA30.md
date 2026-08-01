# Atelier 0.14.0-alpha.30 UI-latency corrections

This document traces the twenty recommendations in `UI_LATENCY_AUDIT_ALPHA29.md` to the alpha.30 implementation.

| # | Recommendation | Alpha.30 correction | Verification |
|---:|---|---|---|
| 1 | One observation for `/status` | The command calls `AtelierCore.status()` once and passes the resulting `AtelierStatus` to `FooterStatusController.refresh()`. | Pi `/status` regression counts one repository observation. |
| 2 | Skip generic slash-command refresh | The `input` event returns before scheduling a footer observation when input starts with `/`. | Slash-command refresh-ownership regression. |
| 3 | Compute closure readiness once | Passive status reads the cached closure result; authoritative closure/full workflow computes it once and caches it. | Status and closure integration tests. |
| 4 | Remove duplicate `/approve` refresh | Approval owns one final status update; the outer command no longer repeats it. | Exact approval Pi tests. |
| 5 | Do not await footer refresh in `tool_call` | Tool authorization returns after durable evidence begins; `tool_result` invalidates and refreshes status. | Tool-start and Pi authorization tests. |
| 6 | Show phase feedback | Repository observation, effect analysis, checkpointing, exact revalidation, reconciliation, convergence, and activation set a working message and yield before work. | Manual guide plus phase-order tests. |
| 7 | Runtime-only model/thinking updates | Footer runtime fields update from Pi events without repository, Beads, closure, or code-provider I/O. | Footer model/thinking regression. |
| 8 | Async Git/Jujutsu observations | Interactive observations use `runProcess()` with cancellation, process groups, startup/idle/total timeouts, and bounded output. | Event-loop responsiveness and provider tests. |
| 9 | Request-scoped `RepositoryObservation` | Snapshot, display, changed paths, batched classifications, optional files, and metrics are returned as one observation. | `interactive-performance.test.ts`. |
| 10 | Cache immutable repository facts | Provider selection, roots, Git common directory, Beads version/initialization, task reads, and provider readiness are cached with explicit invalidation. | Cache-hit and provider tests. |
| 11 | Hash only dirty source | Clean identity uses VCS revisions; dirty identity hashes changed and untracked source paths only. | Repository observation metrics and correctness tests. |
| 12 | Batch path classification | One VCS observation classifies all requested paths rather than launching commands per path. | Permission observation-count tests. |
| 13 | Deduplicate workspace snapshots | Workspace construction, bindings, authorization, and evidence consume supplied observations where their authority boundary permits reuse. | Multi-repository and evidence tests. |
| 14 | Ledger-only default `/workflow` | `/workflow` and `/state` display durable status; `full`/`refresh` explicitly rebuild Working State and retrieval evidence. | Acceptance and Working State tests. |
| 15 | Cache Beads status | Version and `bd where` are cached; routine status does not run `bd list`; rejected cache promises are removed. | Beads CLI provider tests. |
| 16 | Cache code-provider readiness | Provider status has a bounded workspace-qualified cache and coalesced in-flight request; indexing and source changes invalidate it. | Code-service and footer readiness tests. |
| 17 | One authorization observation | Tool and direct-user-shell authorization reuse one observation through workflow, workspace policy, ledger, and execution evidence. | Authorization performance regression. |
| 18 | Prompt before checkpoint copy | Explicit checkpoint-required operations ask first; approval then enters a visible checkpoint phase. | Prompt-before-checkpoint regression. |
| 19 | Bound exact-approval inventories | Preparation, one pre-apply revalidation, and one post-apply convergence inventory are used; apply accepts the revalidated preview. | Execution-workflow inventory-count regression. |
| 20 | Instrument SQLite waits | Ledger operations record duration and potential waits against the configured 5-second busy timeout. `/performance` renders the bounded summary. | Performance recorder and SQLite tests. |

## Interaction contract

The performance corrections do not weaken exactness. Caches are short-lived or immutable, mutation boundaries
invalidate them, and exact approval/closure force the observations required by their authority. The first visible
feedback target is independent of total operation time: Pi should display the current phase before a repository,
provider, checkpoint, or reconciliation operation begins.
