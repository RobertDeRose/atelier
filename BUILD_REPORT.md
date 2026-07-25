# Build report

Atelier v0.10.3 completes the SQLite compatibility boundary required by the Pi shell.

The v0.10.2 runtime selector correctly loaded `bun:sqlite`, but a real launch exposed one remaining
behavioral difference: Bun returns `null` when `Statement.get()` finds no row, while Node's
`DatabaseSync` returns `undefined`. A new repository has no durable state rows yet, so the Pi extension
failed immediately while reading `row.value_json`.

Atelier now wraps Bun statements and normalizes missing rows to `undefined` before they reach the
ledger. The ledger's state and task-mapping lookups also accept either nullish value defensively. The
SQLite path, schema, WAL behavior, migrations, and persisted values are unchanged.

Validation:

- strict TypeScript check: passed
- automated tests: 79 passed, 0 failed
- CLI smoke test: passed
- line coverage: 83.26%
- branch coverage: 66.63%
- function coverage: 84.14%
- Node SQLite integration regression: passed
- Bun SQLite selection regression: passed
- Bun missing-row normalization regression: passed
- Node fallback regression: passed
- Pi launcher argument/root regression: passed
- static `node:sqlite` and `bun:sqlite` imports in the Pi dependency graph: absent
