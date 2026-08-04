# Legacy Decision Record 0002 — Integrate Code Intelligence Before Building It

- Status: Accepted
- Date: 2026-07-20

## Context

Atelier needs code retrieval across single repositories, monorepos, and multi-repository workspaces. Owning parsing, source indexing, embeddings, ranking, graphs, persistence, and invalidation would delay validation of Atelier's primary workflow hypotheses.

## Decision

Atelier owns the provider contract, lifecycle, capability negotiation, normalized evidence, provenance, staleness policy, and Working State integration.

General-purpose indexing is delegated first to external providers. `codesearch` is the planned default proof-of-concept provider; Octocode is the planned second experimental provider.

The public CLI namespace is `code`.

## Consequences

- Native source and symbol indexes from v0.4.0 are removed.
- Provider failures are isolated behind an MCP subprocess boundary.
- Atelier can compare providers without exposing their storage or tool names.
- Concrete adapters require version-specific verification and contract tests.
- Native implementation requires an evaluation-backed decision gate.
