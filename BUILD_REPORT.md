# Atelier v0.8.3 Build Report

## Implemented

- Distinguished provider operational errors from legitimate empty MCP search results.
- Detected codesearch's real `Error opening database for read fallback` response even
  though it used `isError: false`.
- Added bounded codesearch literal fallback for automatic and hybrid searches.
- Kept explicit semantic mode strict so diagnostics cannot hide vector failures.
- Added degraded status and warnings to normalized provenance and provider diagnostics.
- Added `--mode auto|semantic|hybrid|lexical` to `atlr code search`.
- Expanded live probing to capture semantic, hybrid, literal, automatic, and direct CLI
  search behavior, plus codesearch doctor, statistics, and index-store metadata.
- Improved outline probing by using a path returned by the real symbol index.
- Added a portable regression fixture from the second live knowledge archive.
- Added evaluation fields for degraded-result counts and provider warnings.

## Validation

- Strict TypeScript check: passed.
- Automated tests: 33 passed, 0 failed.
- CLI smoke test: passed.
- Coverage: 81.01% lines, 62.65% branches, 77.55% functions.
- Ordinary tests remain isolated from the live codesearch process.
- Live vector behavior still requires the included machine-side collection workflow.
