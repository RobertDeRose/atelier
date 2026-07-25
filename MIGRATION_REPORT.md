# Migration Report — v0.10.1

No database migration is required. Atelier continues to use Node's built-in SQLite implementation and the existing
`.atelier/atelier.db` schema. Only module resolution changed: SQLite is now loaded at runtime rather than through a
static import.

Use the supported development launcher after updating:

```bash
mise run launch
```

Additional Pi arguments are forwarded after the task name, for example:

```bash
mise run launch -- --model <model-pattern>
```

Direct `pi -e ./apps/pi-extension/src/index.ts` remains valid when Pi is running under a compatible Node runtime,
but `mise run launch` is the validated path because it inherits the repository's pinned toolchain.
