# Atelier v0.8.8 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 48 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 83.05%
- Branch coverage: 66.75%
- Function coverage: 81.25%
- Seventh real-provider archive: normalized and committed as a pre-fusion retrieval fixture

## Main correction

The v0.8.7 focus policy raised codesearch mean weighted recall to 0.5625 and ranked product
source first, but semantic candidates still omitted companion files recoverable through exact
provider search. Focused automatic and hybrid searches now fuse bounded semantic and literal
codesearch results before path selection and final truncation.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through
mise. Packaging validation used the available compatible Node runtime and committed
TypeScript dependencies; the pinned mise/Aube workflow remains authoritative.
