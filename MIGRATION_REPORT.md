# Migration Report — v0.10.3

No database migration is required. Atelier continues to use `.atelier/atelier.db` with the existing
schema and WAL settings.

The runtime boundary now guarantees one missing-row contract:

- Pi/Bun: native `null` from `Statement.get()` is normalized to `undefined`;
- CLI/Node: native `undefined` is preserved.

Existing databases and the partially created database from the failed v0.10.2 launch are valid and
should not be removed.

Use the supported interactive launcher after updating:

```bash
mise run launch
```

Additional Pi arguments are forwarded after `--`:

```bash
mise run launch -- --model <model-pattern>
```
