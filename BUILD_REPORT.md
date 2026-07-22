# Atelier v0.8.6 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 41 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 82.09%
- Branch coverage: 64.26%
- Function coverage: 79.31%
- Fifth real-provider archive: normalized and committed as compact regression fixtures

## Main correction

The repaired semantic index included large committed provider-response fixtures and grew
from 1,006 to 16,327 chunks. Those evidence files dominated semantic results. Atelier now
ships `.codesearchignore`, fingerprints corpus-selection inputs, and performs one forced
local rebuild when the selected corpus changes. The baseline evaluator consumes the same
ignore file.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through
mise. Packaging validation used the available compatible Node runtime and the committed
TypeScript dependencies; the pinned mise/Aube workflow on the development machine
remains authoritative.
