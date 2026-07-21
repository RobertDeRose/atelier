# Atelier v0.7.0 Build Report

## Result

The offline implementation is complete and validated without requiring a real codesearch executable.

## Implemented

1. Explicit multi-repository workspace configuration in `.atelier/workspace.json`.
2. Workspace and repository identity validation.
3. Repository-scoped and workspace-wide code search and symbol queries.
4. Relationship retrieval through `atlr code related`.
5. Provider-neutral retrieval budgets for results, previews, chunks, fetches, and total bytes.
6. Compact normalized code evidence in deterministic Working State.
7. Configuration validation through `atlr config validate`.
8. Extended provider diagnostics with workspace mappings and index state.
9. Repeatable code-intelligence evaluation tasks and JSON report generation.
10. Real codesearch conformance probe covering installation, MCP, indexing, search, symbols, edits, reindexing, and evaluation.

## Validation

- Aube install: passed.
- Strict TypeScript check: passed.
- Automated tests: 23 passed, 0 failed.
- CLI smoke test: passed.
- Native AST, Tree-sitter, embeddings, vector indexing, and code-graph ownership remain absent.

## Deferred live confirmation

The build environment did not contain a real codesearch executable. Run `mise run test:codesearch` on a development machine with codesearch installed. The generated `.atelier/codesearch-probe` directory contains all raw artifacts required to finalize provider conformance and update response normalization where necessary.
