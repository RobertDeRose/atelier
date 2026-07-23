# Build report

Atelier v0.9.4 isolates the experimental Octocode provider from the user-wide configuration and uses local FastEmbed models for development and live conformance.

Validation:

- strict TypeScript check: passed
- automated tests: 62 passed, 0 failed
- CLI smoke test: passed
- line coverage: 84.43%
- branch coverage: 65.84%
- function coverage: 83.00%

The validation environment used Node 22 with the available TypeScript compiler and Node declarations. The authoritative development environment remains Node 24.18.0, TypeScript 7, Aube 1.29.1, and the pinned mise toolchain.
