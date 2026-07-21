# Atelier v0.7.1 Build Report

## Result

The authoritative v0.7.0 Git bundle was hardened using the supplied live codesearch 1.1.30 probe results.

## Implemented

1. Explicit Node declarations for the TypeScript 7 project.
2. Exact mise tool versions matching `mise.lock`.
3. Frozen Aube installation from `package-lock.json`.
4. Configurable codesearch index-readiness timeout and polling.
5. Query blocking while the provider reports `building` or `unknown`.
6. Correct local-stdio versus multi-repository client routing.
7. Search arguments aligned with codesearch 1.1.30 semantic/literal modes.
8. Federated `chunk_ref` preservation and fetch-on-demand support.
9. Raw MCP schema/response capture and conformance summaries.
10. Git removal and ignore rules for generated database, probe, and evaluation state.

## Validation

- Strict TypeScript check: passed.
- Automated tests: 25 passed, 0 failed.
- CLI smoke test: passed.
- Coverage: 78.42% lines, 62.89% branches, 75.65% functions.
- Probe shell syntax: passed.
- Package source contains no tracked `.atelier` runtime databases, probe output, evaluation output, or `.codesearch.db` data.

## Environment note

The build container runs Node 22 and does not contain Aube or codesearch. The project itself pins Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through mise. Run `mise install`, `mise run install`, `mise run check`, and `mise run test:codesearch` on the development machine to verify the complete pinned environment and live provider behavior.
