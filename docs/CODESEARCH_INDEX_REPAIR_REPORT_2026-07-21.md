# Codesearch Index Repair Report — 2026-07-21

## Observation

The third live collection reported:

- MCP status: `ready`
- Vector chunks: 1,191
- Vector files: 60
- Vector indexed: `No`
- Doctor: vector store empty/unbuilt and 23 files missing from the index
- Direct semantic search: `Index not built. Call build_index() after inserting chunks.`
- MCP semantic and hybrid search: `Error opening database for read fallback`
- MCP literal search: operational
- Atelier automatic search: ten explicitly degraded lexical results

## Root cause

Atelier used `codesearch index add`. Codesearch returns successfully from that path when a local database already exists, after ensuring registration only. It does not invoke incremental repair in that case.

The bare `codesearch index <path>` implementation performs incremental indexing and calls the vector-store rebuild safety net when source files are unchanged but the vector index is missing.

## Correction

Atelier v0.8.4 uses the bare index command for local operation and verifies `codesearch stats` before accepting the index as ready. The live probe now captures pre- and post-index statistics and requires the post-index vector state to be built.

## Expected next run

The next machine collection should show:

- pre-index `Indexed: No` for the damaged fixture state
- post-index `Indexed: Yes`
- `vector_index_repaired` passing
- direct, semantic, and hybrid search returning results without degraded fallback
- improved semantic retrieval metrics relative to the v0.8.3 degraded run
