# ADR-0007: Exclude Captured Provider Evidence from Code Retrieval

## Status

Accepted.

## Date

2026-07-22.

## Context

The first successful semantic codesearch run repaired the HNSW index but expanded the
repository index from 1,006 to 16,327 chunks. Search results were then dominated by the
large JSON response fixtures under `tests/fixtures/codesearch-*`, including recursively
captured evaluation output. Those files are required for adapter regression tests, but
they are generated evidence rather than implementation context.

Codesearch respects repository-local `.codesearchignore` files. Its incremental indexer
cannot reliably remove a file that still exists and merely became ignored, so changing
search-selection inputs requires a full rebuild to purge stale chunks.

## Decision

Atelier repositories must declare provider-specific corpus exclusions in
`.codesearchignore`. The Atelier repository excludes runtime state, provider databases,
knowledge archives, and committed real-provider response fixtures.

For local codesearch operation, Atelier fingerprints the repository's `.gitignore`,
`.codesearchignore`, and `.osgrepignore` contents together with the provider version.
When that fingerprint differs from the last successful index, Atelier performs one
`codesearch index <path> --force` rebuild only when a populated database existed before
provider startup. A fresh database, or an empty database left by an interrupted first
index, uses the normal `codesearch index <path>` path. The fingerprint is recorded after vector readiness is verified under the
repository-specific external Atelier runtime directory. Older repository-local
`.atelier/codesearch-index-state.json` files are read only for migration and removed
after the next successful index.

The baseline evaluator uses the same `.codesearchignore` file through ripgrep's
`--ignore-file` option so baseline and provider comparisons operate on the same corpus.
Captured evaluation fixtures omit raw subprocess stdout and stderr while retaining tasks,
ranked paths, scores, aggregate metrics, and conformance evidence.

## Consequences

- Regression fixtures remain committed and testable without contaminating retrieval.
- Existing populated indexes perform one full rebuild after this decision.
- Fresh and partially initialized empty indexes use the normal incremental path.
- Later index operations remain incremental until selection inputs or provider version
  change.
- Mutable corpus-selection state no longer enters Git or Jujutsu working-copy scans.
- Provider conformance fails if ignored fixture paths appear in captured results.
- Corpus selection remains explicit and reviewable rather than hidden in adapter code.
