# Atelier v0.8.6 Migration Report

No manual configuration migration is required.

The repository now includes `.codesearchignore`. On the first `atlr code index` after
updating, Atelier detects that the corpus-selection fingerprint changed and runs a full
codesearch rebuild. This is expected and removes previously indexed regression fixtures.
Later runs return to incremental indexing until an ignore file or provider version
changes.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```

The next collection should pass `fixture_pollution`, show a substantially smaller vector
corpus, and report benchmark results that no longer contain paths beneath
`tests/fixtures/codesearch-*`.
