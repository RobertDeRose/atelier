# Atelier v0.8.5 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 37 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 81.54%
- Branch coverage: 63.08%
- Function coverage: 78.49%
- Fourth real-provider archive: normalized and committed as regression fixtures

## Main correction

Atelier now terminates and awaits the local codesearch MCP subprocess before invoking
`codesearch index <path>`. This releases Tantivy's writer lock so the CLI repair path can
build the missing HNSW index. MCP is restarted only after `codesearch stats` reports a
non-empty vector store with `Indexed: Yes`.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through
mise. Packaging validation used the available container Node 22 runtime, global
TypeScript compiler, and compatible Node declarations; the pinned mise/Aube workflow
on the development machine remains authoritative.
