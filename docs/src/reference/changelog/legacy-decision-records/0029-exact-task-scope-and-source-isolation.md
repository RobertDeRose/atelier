# Legacy Decision Record 0029 — Derive exact capabilities and source evidence from structured task scope

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The alpha.5 manual run approved one task whose prose named two writable files, excluded dependency
changes, and required one focused validation. Atelier nevertheless installed a static whole-repository
bundle containing file writes, dependency modification, full-suite validation, task update/link, task
closure, and local-change creation. The approval dialog did not disclose that bundle.

The same run also showed three related evidence problems:

- each mutation was attributed every currently dirty source path rather than the paths changed by that
  operation;
- Jujutsu workflow metadata could change raw change/operation identifiers and invalidate otherwise
  unchanged source evidence;
- a task commit could sweep `.atelier/PLAN.md` or other pre-existing metadata into the implementation
  change.

Free-form scope prose is useful context but is not a reliable authorization language.

## Decision

1. Every approvable plan task must carry an `execution` object in `atlr:task` metadata containing:
   repository-relative `writePaths`, `allowDependencyChanges`, named `validations`, `allowFullSuite`, and
   `allowLocalChange`.
2. Preparation fails when the contract is absent, names an unknown validation, includes a dependency
   manifest without dependency permission, enables a full suite without a named full validation, or
   names a path outside application source.
3. Exact approval derives capabilities only from that contract:
   - reviewed non-dependency write paths as task constraints;
   - `dependency.modify` only for reviewed dependency manifests;
   - named focused/full validation permissions only;
   - one `repository.change.create` permission scoped to reviewed paths when enabled;
   - `task.close` after the authoritative completion predicate.
   Task update/link and generic shell permissions are not implicit.
4. The complete human-readable capability projection and exclusions are displayed before approval and
   included in the approval digest.
5. Repository snapshots retain raw VCS identity for diagnostics, but approval, retrieval, validation, and
   execution freshness use a source-only base revision and source fingerprint. Workflow/provider metadata
   does not invalidate source evidence by itself.
6. Tool evidence records the source-path delta attributable to that operation, separate from paths that
   were already dirty.
7. Git and Jujutsu task commits are restricted to the reviewed source paths. Unapproved or workflow
   metadata cannot be swept into the task change.
8. Beads initialization checks provider state first and is idempotent; destructive reinitialization is not
   an implicit consequence of running `atlr init --beads` again.

## Consequences

- Existing alpha.5 plan documents without structured execution metadata cannot be newly prepared or
  resumed as exact alpha.6 executions; they must be updated and reviewed again.
- An approval is materially inspectable rather than relying on a capability digest alone.
- Narrow tasks no longer receive whole-repository mutation authority.
- Source evidence remains stable across Atelier, Beads, and provider-metadata churn while raw VCS details
  remain available for recovery and diagnostics.
- Path-scoped commits may leave unrelated pre-existing changes in the working copy; closure must report
  those changes rather than silently include them.
