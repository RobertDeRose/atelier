# Atelier v0.8.5 Migration Report

No configuration migration is required.

`atlr code index` now closes any self-contained codesearch MCP subprocess before running
the local CLI indexer. This prevents the `Failed to acquire Lockfile: LockBusy` failure
captured by the fourth live-provider run. Serve-backed `codeMode: "client"` behavior is
unchanged.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```

The next collection should show `index` and `reindex_after_edit` exiting successfully,
`codesearch stats` changing to `Indexed: Yes`, and semantic/hybrid retrieval operating
without degraded literal fallback.
