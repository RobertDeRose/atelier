# ADR-0036: Interactive observation pipeline

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Atelier's safety and workflow state depends on repository observations, task-provider state, validation evidence,
code-provider health, recovery checkpoints, and durable SQLite records. Alpha.29 computed those facts correctly,
but interactive commands frequently recomputed the same state several times. Git and Jujutsu observations also
used synchronous subprocesses on Pi's JavaScript event loop. A single `/status`, `/workflow`, permission decision,
or exact approval could therefore block rendering for several seconds before Pi showed any indication of work.

The safety boundary must remain fail-closed, but presentation must not repeatedly rebuild that boundary. The
interactive host also needs bounded diagnostics that explain where latency came from rather than treating every
pause as an opaque UI problem.

## Decision

Atelier uses one request-scoped observation pipeline for interactive work:

1. Git and Jujutsu repository observations run asynchronously through the bounded process runner with startup,
   idle, and total timeouts, cancellation, process-group termination, and bounded output.
2. A `RepositoryObservation` contains snapshot identity, display state, changed paths, batched path
   classifications, optional file inventory, subprocess counts, hashed files and bytes, and cache provenance.
3. One user action reuses that observation through status presentation, workflow authorization, workspace effect
   evaluation, approval evidence, recovery preparation, and execution-evidence start whenever those consumers
   share the same source boundary.
4. Repository roots, Git common directories, provider selection, Beads version/initialization probes, task reads,
   and code-provider readiness use short-lived or immutable caches. Rejected cache promises are discarded.
5. Clean repository identity uses VCS revision state. Dirty-source fingerprints hash only changed and untracked
   source paths instead of rereading every tracked source file.
6. `/status` calculates one status view and shares it with the footer. Slash-command input does not schedule a
   competing generic refresh. Model and thinking-level changes update runtime footer fields without repository,
   task-provider, closure, or code-provider I/O.
7. `/workflow` is ledger/status-only by default. `/workflow full` and `/workflow refresh` explicitly request the
   retrieval-backed authoritative reconstruction.
8. Closure readiness is calculated authoritatively at closure boundaries and cached for passive status display;
   passive status does not run the complete closure predicate repeatedly.
9. Permission handling shows effect-analysis feedback immediately. An explicit prompt occurs before an expensive
   recovery checkpoint is copied; after approval, the checkpoint phase is visible. Tool start does not wait for a
   footer refresh.
10. Exact approval uses three task inventories: preparation, one pre-apply revalidation, and one post-apply
    convergence check. A freshly revalidated preview is passed into application instead of triggering a hidden
    preview.
11. Interactive and SQLite operations record bounded session-local timing samples. `/performance` reports phase
    duration, subprocess count, files and bytes hashed, cache behavior, and potential SQLite lock waits.

Presentation refreshes are serialized and coalesced. A stale or slower observation cannot overwrite a newer
footer state. Source-changing tool completion explicitly invalidates repository and code-readiness caches.

## Consequences

- Pi can render phase feedback before expensive work because repository subprocesses no longer block the event
  loop.
- `/status`, default `/workflow`, and common permission decisions perform substantially less duplicate work.
- Safety decisions remain based on current source observations; caches are bounded, invalidated at mutation
  boundaries, and bypassed for exact revalidation.
- Passive status may report closure evidence as pending until an authoritative closure or full-workflow refresh
  computes it. This is deliberate and is not treated as closure authority.
- `/workflow full` remains more expensive because it explicitly asks for provider and evidence reconstruction.
- Synchronous repository methods remain available for non-interactive compatibility and finalization paths, but
  they are not used for Pi's routine status, permission, or exact-approval observation path.
- Timing telemetry is diagnostic, bounded, and local. It does not persist raw command output or secrets.
