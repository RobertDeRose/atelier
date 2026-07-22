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
`codesearch index <path> --force` rebuild. The fingerprint is recorded in ignored
Atelier runtime state after vector readiness is verified.

The baseline evaluator uses the same `.codesearchignore` file through ripgrep's
`--ignore-file` option so baseline and provider comparisons operate on the same corpus.
Captured evaluation fixtures omit raw subprocess stdout and stderr while retaining tasks,
ranked paths, scores, aggregate metrics, and conformance evidence.

## Consequences

- Regression fixtures remain committed and testable without contaminating retrieval.
- The first index after this decision performs a full rebuild.
- Later index operations remain incremental until selection inputs or provider version
  change.
- Provider conformance fails if ignored fixture paths appear in captured results.
- Corpus selection remains explicit and reviewable rather than hidden in adapter code.
