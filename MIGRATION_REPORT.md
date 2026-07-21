# Atelier v0.8.4 Migration Report

No configuration migration is required.

`atlr code index` now performs real local repair and incremental indexing rather than calling `codesearch index add` for an existing local database. The first run may take longer because interrupted vector indexes are rebuilt.

Serve-backed `codeMode: "client"` continues to use repository registration and routed provider status.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```
