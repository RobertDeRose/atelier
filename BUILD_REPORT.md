# Atelier v0.8.7 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 46 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 82.77%
- Branch coverage: 66.12%
- Function coverage: 80.55%
- Sixth real-provider archive: normalized and committed as a clean-corpus regression fixture

## Main correction

The clean 2,138-chunk codesearch index was healthy, but implementation-oriented queries
were dominated by documentation before Atelier's 10-result cutoff. Atelier now overfetches
a bounded compact candidate pool, resolves source/test/docs focus, preserves provider rank,
diversifies paths, and applies the final retrieval budget after workflow selection.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through
mise. Packaging validation used the available compatible Node runtime and committed
TypeScript dependencies; the pinned mise/Aube workflow remains authoritative.
