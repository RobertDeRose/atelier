# Build report

Atelier v0.10.2 corrects the runtime assumption in the first Pi launcher release.

A real `mise run launch` showed that Pi is a Bun executable. The extension therefore runs inside Bun's
Node-compatibility layer, where `process.version` is available but `node:sqlite.DatabaseSync` is not.
Atelier now detects Bun and loads `bun:sqlite`; Node consumers continue loading `node:sqlite`. Both
implementations are hidden behind the existing synchronous `SqliteDatabase` interface, so the database
path, schema, WAL behavior, and ledger semantics are unchanged.

The release also canonicalizes existing repository roots before launch, preventing macOS `/var` and
`/private/var` aliases from producing false launcher failures or separate state paths.

Validation:

- strict TypeScript check: passed
- automated tests: 78 passed, 0 failed
- CLI smoke test: passed
- line coverage: 83.20%
- branch coverage: 66.50%
- function coverage: 84.28%
- Node SQLite integration regression: passed
- Bun SQLite selection regression: passed
- Node fallback regression: passed
- Pi launcher argument/root regression: passed
- static `node:sqlite` and `bun:sqlite` imports in the Pi dependency graph: absent
