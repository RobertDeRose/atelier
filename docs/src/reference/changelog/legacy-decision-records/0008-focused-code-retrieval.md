# Legacy Decision Record 0008 — Apply Workflow Focus After Provider Retrieval

## Status

Accepted.

## Context

The v0.8.6 live run proved that codesearch 1.1.30 was healthy after fixture exclusion:
its vector index was built, semantic and hybrid search worked, and no committed provider
fixtures leaked into results. The compact corpus contained 2,138 chunks across 97 files.

However, implementation-oriented benchmark questions were dominated by design documents.
The expected implementation files were often present within the provider's top 25 results,
but Atelier requested and retained only the first 10. The clean-corpus benchmark recorded
mean weighted recall of 0.1072 for codesearch versus 0.9643 for the ripgrep baseline.

The provider should remain responsible for semantic indexing and ranking. Atelier still
needs a workflow-aware selection policy because an agent investigating implementation,
tests, or documentation has different evidence priorities.

## Decision

Atelier introduces a provider-neutral search focus:

```text
auto
source
tests
docs
all
```

For focused semantic, hybrid, or lexical retrieval, the adapter requests a bounded compact
candidate pool of up to 50 results, normally at least 25. Atelier then:

1. Classifies paths as product source, tests, documentation, tooling, or other.
2. Prioritizes the class appropriate to the resolved focus.
3. Preserves provider order within each class.
4. Diversifies paths before returning duplicate chunks from the same file.
5. Truncates to the original user-visible retrieval budget.
6. Preserves the provider's original rank and score in every result.
7. Records the resolved focus, overfetch, reranking, and diversification in provenance.

`auto` uses small deterministic query heuristics. Callers may override it with
`--focus source|tests|docs|all`.

## Consequences

- Atelier does not build a competing index or replace provider scoring.
- Compact overfetch increases provider metadata returned but not the final Working State
  evidence budget.
- Provider rank remains inspectable through `providerRank`.
- The same focus policy is applied to the ripgrep baseline so evaluation remains fair.
- Neutral searches retain provider order through `focus=all`.
- Future providers can use the same policy without reproducing codesearch-specific logic.
