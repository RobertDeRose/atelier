# Build report

Atelier v0.10.1 fixes the first real Pi-shell launch blocker found after v0.10.0 validation.

Pi loads TypeScript extensions through jiti. Atelier previously exposed a static `node:sqlite` import through
its Core dependency graph, causing Pi to reject the extension before initialization even though the pinned Node
runtime supports SQLite. The release now resolves `DatabaseSync` through `process.getBuiltinModule()` behind an
Atelier-owned database interface. The ledger schema, database path, and synchronous persistence behavior are
unchanged.

The release also adds `atlr launch` and `mise run launch`. The launcher runs Pi from the selected repository root,
loads the Atelier extension explicitly, inherits the mise toolchain environment, and forwards Pi arguments.

Validation:

- strict TypeScript check: passed
- automated tests: 76 passed, 0 failed
- CLI smoke test: passed
- line coverage: 83.15%
- branch coverage: 66.36%
- function coverage: 84.71%
- dynamic SQLite runtime regression: passed
- Pi launcher argument/root regression: passed
- static `node:sqlite` imports in the Pi dependency graph: removed
