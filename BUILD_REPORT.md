# Build report

Atelier v0.9.6 aligns the experimental Octocode provider with the real 0.14.0 text-based MCP result format.

Validation:

- strict TypeScript check: passed with the available TypeScript compiler and Node declarations
- automated tests: 66 passed, 0 failed
- CLI smoke test: passed
- line coverage: 84.78%
- branch coverage: 66.14%
- function coverage: 83.89%

The authoritative development environment remains Node 24.18.0, TypeScript 7, Aube 1.29.1, and the pinned mise toolchain. The packaging environment used Node 22 and TypeScript 5.8.3 for the additional clean validation.
