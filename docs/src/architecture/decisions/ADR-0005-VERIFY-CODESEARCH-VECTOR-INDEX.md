# ADR-0005: Verify Codesearch Vector Index Readiness

## Status

Accepted — 2026-07-21

## Context

A real codesearch 1.1.30 run reported MCP index state `ready` while `codesearch stats` showed 1,191 chunks and `Indexed: No`. Semantic and hybrid searches then failed with `Error opening database for read fallback`, while lexical search remained available.

The prior Atelier adapter invoked `codesearch index add <path>`. In codesearch 1.1.30, that command creates and registers a new index, but returns early when a local database already exists. It therefore does not repair an existing database whose HNSW index was never built.

Codesearch's bare `codesearch index <path>` path performs incremental indexing and explicitly rebuilds a missing vector index when no source files changed.

## Decision

For local and auto-local operation, Atelier will:

1. Run `codesearch index <repository-root>`.
2. Run `codesearch stats <repository-root>`.
3. Require at least one chunk and `Indexed: Yes`.
4. Reject the operation as failed when chunks exist but the HNSW index is not built.
5. Reconnect to MCP and wait for routed status only after local verification succeeds.

For serve-backed client operation, Atelier retains `codesearch index add <repository-root>` for registration and background creation, then waits on routed provider status.

MCP `ready` is not sufficient evidence of local semantic readiness.

## Consequences

- Existing interrupted indexes are repaired instead of merely re-registered.
- `atlr code index` can take longer because it performs real indexing work.
- Local conformance now fails when vector statistics remain unbuilt.
- Lexical fallback remains a degraded query path, not proof that indexing succeeded.
- Client-mode vector health still depends on the serve instance's routed status until codesearch exposes structured per-capability health.
