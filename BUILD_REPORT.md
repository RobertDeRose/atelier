# Atelier v0.8.1 Build Report

## Implemented

- Isolated all ordinary tests from the real codesearch process.
- Added an explicit `test:codesearch:live` task and compatibility alias.
- Added actionable failure for empty codesearch fixture imports.
- Normalized local codesearch paths to repository-relative domain paths.
- Imported the complete verified codesearch 1.1.30 MCP, search, symbol, fetch, outline,
  impact, conformance, and evaluation fixtures.
- Added regression coverage for real tool schemas and response payloads.
- Separated codesearch cold-start timing from steady-state evaluation.
- Added ranked returned paths, weighted recall, reciprocal rank, nDCG@10, and aggregate
  evaluation metrics.
- Replaced the initial exact-path task set with weighted relevance rubrics.
- Expanded live conformance checks for fetch, outline, optional tools, and impact support.
- Published the first evidence-based codesearch evaluation report.

## Validation

- Strict TypeScript check: passed.
- Automated tests: 28 passed, 0 failed.
- CLI smoke test: passed.
- Line coverage: 80.07%.
- Branch coverage: 61.56%.
- Function coverage: 76.45%.
- Ordinary test duration in this environment: approximately 7 seconds; no live-provider
  timeout was observed.

Run `mise run check` for the authoritative pinned development gate. Run
`mise run collect:codesearch` on the development machine to generate the second weighted
live evaluation and updated portable fixtures.
