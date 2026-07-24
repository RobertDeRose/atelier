# Build report

Atelier v0.9.5 aligns the experimental Octocode provider with the verified 0.14.0 indexing contract and makes project-local development configuration deterministic.

Validation:

- strict TypeScript check: passed with the available TypeScript compiler and Node declarations
- automated tests: 64 passed, 0 failed
- CLI smoke test: passed
- line coverage: 84.54%
- branch coverage: 65.94%
- function coverage: 83.14%

The authoritative development environment remains Node 24.18.0, TypeScript 7, Aube 1.29.1, and the pinned mise toolchain. The packaging environment used Node 22 and TypeScript 5.8.3 for the additional clean validation.
