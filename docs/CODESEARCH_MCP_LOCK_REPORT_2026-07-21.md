# Codesearch MCP Writer-Lock Report — 2026-07-21

## Evidence

The fourth live-provider archive was collected from codesearch 1.1.30 after Atelier
v0.8.4 adopted the correct bare local repair command.

Before and after the attempted repair, `codesearch stats` reported:

```text
Total chunks: 1006
Total files: 55
Indexed: No
```

`atlr code index` failed with:

```text
Failed to create FTS writer after 5 retries: Failed to acquire Lockfile: LockBusy
```

MCP status still reported ready, symbol lookup and literal search remained operational,
and automatic search returned degraded literal fallback results. Semantic and hybrid
search continued to report `Error opening database for read fallback`.

## Interpretation

The repair command itself was correct, but Atelier started it while the MCP child created
by the same `CodesearchProvider` instance was still alive. That process held Tantivy's
writer lock. This was an adapter lifecycle error, not evidence that the bare codesearch
index command was unsuitable.

## Correction

Atelier v0.8.5 closes and awaits the local MCP child before spawning the CLI indexer.
After CLI indexing and vector-stat verification succeed, Atelier reconnects MCP and
performs the usual readiness check.

## Expected next evidence

A successful live collection should show:

- `index.status` and `reindex_after_edit.status` equal to 0;
- `codesearch_stats_after` reports `Indexed: Yes`;
- conformance includes `vector_index_repaired`;
- raw semantic and hybrid MCP calls return results rather than vector-store errors;
- automatic evaluation results have `degradedResultCount: 0`.
