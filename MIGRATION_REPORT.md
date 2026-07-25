# Migration Report — v0.10.2

No database migration is required. Atelier continues to use `.atelier/atelier.db` with the existing
schema and WAL settings.

The runtime boundary now chooses the SQLite implementation supplied by the process hosting Atelier:

- Pi/Bun: `bun:sqlite`
- CLI/Node: `node:sqlite`

Use the supported interactive launcher after updating:

```bash
mise run launch
```

Additional Pi arguments are forwarded after `--`:

```bash
mise run launch -- --model <model-pattern>
```

Existing repository roots are resolved to their canonical filesystem path before Pi starts. This may
change `/var/...` to `/private/var/...` on macOS, but it points to the same files and prevents duplicate
Atelier state locations.
