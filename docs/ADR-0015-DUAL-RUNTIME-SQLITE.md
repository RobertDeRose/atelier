# ADR-0015: Support Node and Bun SQLite runtimes at the ledger boundary

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

The v0.10.1 launcher removed the static `node:sqlite` import and passed repository checks under Node. A real `mise run launch` still failed because Pi is distributed as a Bun executable and evaluates extensions inside Bun. Its Node compatibility layer reports a Node version, but it does not expose Node's `DatabaseSync` implementation.

Bun provides a synchronous built-in SQLite driver through `bun:sqlite`. Its database and statement operations match the small interface Atelier already owns: `exec`, `prepare`, `run`, `get`, `all`, and `close`.

The launcher regression also exposed macOS path aliasing: temporary paths may be created beneath `/var` while child processes report the canonical `/private/var` path.

## Decision

Atelier will select the synchronous SQLite implementation at runtime:

- prefer `bun:sqlite` when a Bun runtime is detected;
- use `node:sqlite` for the Node CLI, tests, and other Node consumers;
- keep both modules behind the existing `SqliteDatabase` interface;
- avoid static imports of either SQLite built-in in the Pi dependency graph;
- canonicalize an existing CLI root with `realpath` before launching Pi or opening state.

The database path, schema, WAL mode, migrations, and synchronous ledger semantics remain unchanged.

## Consequences

- Pi can open the Atelier ledger inside its actual Bun extension runtime.
- The Node CLI continues using Node's built-in SQLite implementation.
- No npm native SQLite dependency or database conversion is introduced.
- Runtime selection and fallback behavior are independently testable.
- macOS `/var` and `/private/var` aliases resolve to one Atelier state location.
- The longer-term shell-to-core process boundary remains valid future architecture, but is not required merely to launch the current vertical slice.
