# Legacy Decision Record 0010 — Exact Identifier Retrieval Hints

## Status

Accepted.

## Context

The first live semantic-plus-literal fusion run raised codesearch mean weighted recall to
0.8571, but generic natural-language augmentation terms such as `provider`, `service`, and
`tests` also introduced unrelated matches. Test-oriented questions could additionally fill
the final result budget with test files while omitting the companion implementation.

Atelier must improve workflow retrieval without creating a native lexical index or hiding
which evidence came from the external provider.

## Decision

- Keep semantic retrieval as the primary automatic query.
- Augment healthy semantic results only with exact identifiers supplied as query hints or
  identifiers already expressed in code-like or quoted form.
- Reserve broad natural-language candidate extraction for degraded fallback after semantic
  provider failure.
- Expose comma-separated exact hints through `atlr code search --hint`.
- Record hints in retrieval provenance and evaluation metrics.
- Infer an internal mixed source/test focus for questions that explicitly request both, and
  interleave source and test paths while preserving provider order within each class.

## Consequences

Generic workflow nouns no longer create healthy-search augmentation traffic. Agent workflows
can pass identifiers discovered during investigation, plans, diagnostics, or prior retrieval
steps. Mixed implementation-and-test questions retain both evidence classes inside the final
bounded result set. Explicit semantic and lexical modes remain unchanged.
