# Legacy Decision Record 0003 — Use codesearch as the Default Code Provider

- Status: Accepted
- Date: 2026-07-20

## Context

Atelier requires local, token-efficient, multi-repository code intelligence without owning a general-purpose parsing and indexing engine. codesearch exposes hybrid search, symbol navigation, fetch-on-demand, and multi-repository routing over MCP.

## Decision

Use codesearch as Atelier's default proof-of-concept Code provider. Integrate through its public CLI and MCP boundary only. Atelier invokes `codesearch index add`, starts `codesearch mcp`, negotiates tools, and maps `search`, `find`, `get_chunk`, and `status` into provider-neutral domain types.

## Consequences

- Atelier does not depend on codesearch databases or Rust libraries.
- Provider references remain opaque.
- Multi-repository mode requires codesearch serve plus MCP client mode.
- Provider output is evidence and retains explicit provenance and staleness.
- Octocode can be evaluated through the same contract.
- Native indexing remains gated by comparative evidence.
