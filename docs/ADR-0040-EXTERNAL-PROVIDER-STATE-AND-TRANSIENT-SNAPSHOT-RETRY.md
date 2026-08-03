# ADR-0040: Keep Mutable Provider State Outside the Working Copy

## Status

Accepted.

## Date

2026-08-03.

## Context

Codesearch records a corpus-selection fingerprint after indexing. Earlier releases
stored that mutable JSON file under `.atelier/` and wrote it through an adjacent
`<name>.<pid>.tmp` file followed by an atomic rename.

During guided acceptance, Jujutsu discovered the temporary file while snapshotting
the working copy, but codesearch renamed it before Jujutsu opened it. Jujutsu then
failed the repository observation with `ENOENT`. The final provider state remained
valid and ManualEdit continued, but an implementation detail from a provider leaked
into VCS observation and produced a user-visible exception.

Atelier already requires its mutable ledger and runtime state to live outside the
repository. Provider selection state has the same lifecycle and should follow the
same boundary.

## Decision

- Store codesearch corpus-selection state under the repository-specific external
  Atelier runtime directory, in `runtimeDirectory/code/codesearch-index-state.json`.
- Write the external state with a unique mode-0600 temporary file and an atomic
  same-filesystem rename.
- Read the former `.atelier/codesearch-index-state.json` location only as a migration
  source. After the next successful index, write external state and remove the legacy
  file.
- Keep compatibility ignore patterns for temporary names produced by older Atelier
  releases.
- Retry a Jujutsu observation only when its diagnostic proves the narrow transient
  race: working-copy snapshot failure, `ENOENT`, and an `.atelier/*.tmp` path. Use a
  short bounded retry sequence and preserve cancellation. Do not retry unrelated
  repository failures.
- Acceptance evidence records both the external selection-state path and whether a
  legacy repository-local file remains.

## Consequences

- Codesearch indexing no longer introduces mutable selection files into Git or
  Jujutsu working-copy scans.
- Repository snapshots and plan review are insulated from provider-state atomic
  renames.
- Existing installations migrate without discarding their prior fingerprint.
- A narrowly recognized old-writer race can recover automatically, while ordinary
  Jujutsu errors remain explicit and fail closed.
- Provider runtime directories must remain external, private, and managed by
  Atelier's runtime-retention policy.
