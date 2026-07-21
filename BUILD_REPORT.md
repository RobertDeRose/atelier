# Atelier v0.8.2 Build Report

## Implemented

- Fixed `collect:codesearch` stopping immediately after a failed conformance probe.
- Preserved the original probe exit status while always running fixture normalization.
- Added automatic creation of `atelier-codesearch-knowledge.tar.xz`.
- Printed the conformance summary and archive location before returning a failure.
- Classified missing optional impact indexers as warnings even when MCP sets `isError`.
- Accepted MCP `structuredContent` when validating fetch and outline results.
- Added regression coverage for failed collection, retained artifacts, archives, and
  optional impact capability gaps.

## Validation

- Strict TypeScript check: passed.
- Automated tests: 30 passed, 0 failed.
- CLI smoke test: passed.
- Focused collection and conformance regressions: passed.
- The ordinary suite remained isolated from the live codesearch process.

Run `mise run collect:codesearch`. If provider conformance fails, the task returns nonzero
but still creates `.atelier/codesearch-probe`, normalized fixtures, and
`atelier-codesearch-knowledge.tar.xz` for diagnosis.
