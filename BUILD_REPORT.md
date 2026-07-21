# Atelier v0.8.4 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 35 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 81.34%
- Branch coverage: 62.92%
- Function coverage: 78.17%
- Third real-provider archive: normalized and committed as regression fixtures

## Main correction

Local and auto-local codesearch indexing now run `codesearch index <path>` and verify a non-empty vector store with `Indexed: Yes`. MCP `ready` alone is no longer accepted as evidence of local semantic readiness.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through mise. Packaging validation used the available container Node runtime with the committed dependencies.
