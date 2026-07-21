# Atelier v0.8.3 Migration Report

No configuration migration is required from v0.8.2.

`atlr code search` now accepts:

```bash
atlr code search --mode auto QUERY
atlr code search --mode semantic QUERY
atlr code search --mode hybrid QUERY
atlr code search --mode lexical QUERY
```

`auto` remains the default. When a semantic provider operation fails, automatic and
hybrid searches use a bounded literal fallback and mark returned evidence as degraded.
Explicit semantic mode returns a nonzero error instead of silently returning an empty
array.

Provider status and result provenance may now contain:

```json
{
  "degraded": true,
  "warnings": ["provider error text"]
}
```

Run `mise run collect:codesearch` after upgrading. The resulting archive now includes
separate semantic, hybrid, literal, and automatic search evidence; codesearch doctor and
statistics output; direct CLI search output; and metadata for the local `.codesearch.db`
store. No database contents are copied.
