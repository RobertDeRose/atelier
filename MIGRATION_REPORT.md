# Atelier v0.8.1 Migration Report

No configuration migration is required from v0.8.0.

The ordinary test suite is now fully isolated from live code providers. Use the explicit
live task when codesearch is installed:

```bash
mise run test:codesearch:live
```

`mise run test:codesearch` remains an alias.

Fixture import now fails when no recognized probe artifacts exist. Run:

```bash
mise run collect:codesearch
mise run fixtures:codesearch
```

The comparative evaluation report schema now includes a separate `coldStart` record,
repository-relative ranked paths, weighted recall, reciprocal rank, nDCG@10, and aggregate
metrics. Consumers of `.atelier/evaluation/latest.json` should tolerate these added fields.
