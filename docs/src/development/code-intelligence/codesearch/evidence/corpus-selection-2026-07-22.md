# Codesearch Corpus Selection Report — 2026-07-22

## Result of the fifth live run

The local lifecycle correction succeeded:

- 42 conformance checks passed;
- no required checks failed;
- the only warning was the unavailable optional SCIP impact indexer;
- the vector store changed from 1,006 unbuilt chunks to 16,327 built chunks;
- semantic, hybrid, literal, fetch, outline, and edit/reindex operations succeeded;
- automatic search returned non-degraded semantic evidence.

## Remaining retrieval-quality issue

The repaired index included committed provider-response fixtures. The direct semantic
query returned large JSON evaluation fixtures ahead of implementation source. The
weighted four-task benchmark therefore reported:

- baseline mean weighted recall: 0.8571;
- codesearch mean weighted recall: 0.1072;
- baseline mean nDCG@10: 0.2031;
- codesearch mean nDCG@10: 0.0568.

This result does not show that semantic code retrieval is intrinsically poor. It shows
that the evaluated corpus was polluted by generated evidence that recursively describes
the same queries, expected files, and prior results.

## Correction

The repository now includes `.codesearchignore` and excludes all
`tests/fixtures/codesearch-*` directories. Atelier fingerprints repository selection
inputs and requests one force rebuild when they change, ensuring already-indexed fixture
chunks are removed. The baseline evaluator consumes the same ignore file.

The next live collection must verify that no ignored fixture path appears in results and
rerun the weighted benchmark against the corrected corpus before changing query routing
or beginning an Octocode comparison.
