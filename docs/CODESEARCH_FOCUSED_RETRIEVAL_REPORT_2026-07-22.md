# Codesearch Focused Retrieval Report — 2026-07-22

## Evidence

The sixth live archive established a clean and healthy codesearch corpus:

- 2,138 chunks across 97 files.
- HNSW vector index built and searchable.
- Semantic, hybrid, literal, fetch, and outline operations healthy.
- No captured codesearch fixture paths in results.
- 42 conformance checks passed, one optional impact-indexer warning, no failures.

The remaining issue was result selection. For implementation questions, codesearch returned
semantically accurate design documentation before implementation files. The original
provider search with 25 results did contain `packages/core/src/code/service.ts`,
`packages/core/src/core.ts`, and `packages/core/src/code/registry.ts`, but Atelier's
10-result cutoff discarded some of them.

The clean-corpus benchmark recorded:

```text
Baseline mean weighted recall:   0.9643
Codesearch mean weighted recall: 0.1072
Baseline mean reciprocal rank:   0.3194
Codesearch mean reciprocal rank: 0.0417
Baseline mean nDCG@10:           0.4409
Codesearch mean nDCG@10:         0.0523
```

## Correction

Atelier now performs bounded compact overfetch and workflow-focused path-diverse reranking.
The policy does not alter provider scores or index contents. It preserves `providerRank`
and records all post-processing in provenance.

The next live collection should determine whether source/test focus recovers expected
implementation paths without reintroducing fixture pollution or semantic degradation.
