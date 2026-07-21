# Codesearch Vector-Store Observation — 2026-07-21

## Source

The report is based on the second live knowledge archive produced from Atelier v0.8.2
against codesearch 1.1.30 on macOS ARM64.

## Observed state

- Index registration and readiness succeeded.
- MCP initialization and tool discovery succeeded.
- Definition lookup returned three results.
- Semantic search returned no normalized hits because the raw MCP response contained:

```text
Error searching vector store: Error opening database for read fallback
```

- The response incorrectly used `isError: false`.
- The four-task codesearch evaluation consequently reported zero weighted recall.
- Literal/symbol infrastructure remained usable, so this was not a total index failure.

## Atelier response

v0.8.3 distinguishes provider errors from legitimate empty results. Automatic search
falls back to bounded literal retrieval and marks the evidence degraded. Explicit semantic
mode surfaces the failure. The machine probe now captures semantic, hybrid, literal,
automatic, direct-CLI, doctor, statistics, and store-metadata evidence so the next archive
can determine whether the defect is MCP-specific, vector-store-specific, or index-state
specific.
