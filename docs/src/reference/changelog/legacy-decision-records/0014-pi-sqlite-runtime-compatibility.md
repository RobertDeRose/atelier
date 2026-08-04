# Legacy Decision Record 0014 — Resolve SQLite dynamically for Pi extension compatibility

- **Status:** Superseded by ADR-0015
- **Date:** 2026-07-25

## Context

Atelier Core used a static `import { DatabaseSync } from "node:sqlite"`. Repository checks passed under the mise-pinned Node 24 runtime, but Pi loads TypeScript extensions through jiti. A real launch through `pi -e` failed during extension resolution with `No such built-in module: node:sqlite` before Atelier could initialize.

The database API itself was not failing. The failure occurred because the extension loader attempted to resolve a newer Node built-in statically. Adding a second SQLite implementation would increase native dependency and migration risk without addressing the actual boundary.

## Decision

Atelier initially retained Node's built-in synchronous SQLite implementation and resolved it at runtime through `process.getBuiltinModule("node:sqlite")` behind an Atelier-owned `SqliteDatabase` interface. A real Pi launch later proved that Pi executes extensions inside Bun, so runtime resolution alone was insufficient. ADR-0015 replaces this decision with a dual Node/Bun SQLite boundary.

Atelier also provides `atlr launch` and `mise run launch` as the supported development entry point. The launcher starts Pi from the repository root, loads the Atelier extension explicitly, forwards Pi arguments, and inherits the mise-pinned runtime environment.

## Consequences

- Pi/jiti no longer encounters a static `node:sqlite` import while loading the extension.
- The existing database format and synchronous ledger semantics remain unchanged.
- No native npm SQLite dependency is introduced.
- Unsupported runtimes fail with an actionable message directing the user to `mise run launch`.
- Direct `pi -e` remains possible, but the Atelier launcher is the validated path.
