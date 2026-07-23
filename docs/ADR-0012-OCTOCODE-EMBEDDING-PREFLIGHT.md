# ADR-0012: Verify Octocode embedding prerequisites and searchable blocks

- Status: Accepted
- Date: 2026-07-23

## Context

Octocode 0.14.0 can advertise its MCP tools and return success from `octocode index` while its configured cloud embedding API key is absent. The observed run produced zero searchable blocks and semantic queries failed with `VOYAGE_API_KEY environment variable not set`.

## Decision

Atelier will inspect the configured code embedding model, require the matching cloud-provider environment variable when applicable, and verify non-zero searchable block counts after indexing. It will not silently modify Octocode's user-level configuration. MCP tool discovery and non-semantic capabilities remain observable even when semantic prerequisites are unavailable.

## Consequences

- Missing credentials fail quickly and actionably instead of after a long indexing run.
- A zero-block index cannot be reported as ready.
- Local embedding builds remain supported without cloud keys.
- GraphRAG and other optional tools remain capability-gated.
