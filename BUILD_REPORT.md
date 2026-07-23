# Build report

Atelier v0.9.3 hardens the experimental Octocode adapter against the real 0.14.0 cloud-embedding and MCP behavior captured on macOS ARM.

Validation:

- strict TypeScript check: passed
- automated tests: 59 passed, 0 failed
- CLI smoke test: passed
- line coverage: 84.19%
- branch coverage: 65.85%
- function coverage: 82.89%

The validation environment used Node 22 with the available TypeScript compiler and Node declarations. The authoritative development environment remains Node 24.18.0, TypeScript 7, Aube 1.29.1, and the pinned mise toolchain.
