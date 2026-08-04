# Legacy Decision Record 0012 — Capability-gate Octocode against its live MCP contract

## Status

Accepted.

## Context

The first live Octocode 0.14.0 run on macOS ARM advertised `semantic_search`,
`structural_search`, and `view_signatures`. It did not advertise `graphrag`, even
though project-level documentation describes GraphRAG as an available feature.
The initial Atelier collector also placed boolean flags before positional query
arguments, causing its search and relationship commands to fail before provider
invocation.

## Decision

Atelier will treat runtime MCP tool discovery as authoritative:

- semantic retrieval is enabled only when `semantic_search` is advertised;
- file-outline capability is enabled only when `view_signatures` is advertised;
- relationships are enabled only when `graphrag` is advertised;
- structural search is captured as provider evidence but is not added to the
  minimum `CodeProvider` interface until a provider-neutral operation is defined;
- Octocode queries use the documented array-preferred `query`, `max_results`,
  `mode`, and `detail_level` fields;
- each repository retains its own local MCP process;
- first-time indexing receives a separate bounded 30-minute timeout;
- the collector directly invokes every advertised tool and records unavailable
  optional capabilities as warnings.

## Consequences

The experimental provider no longer claims graph or definition capabilities that
were not present in the observed server. Future Octocode versions can enable those
capabilities without core changes when their MCP tools are advertised. A second
machine-side collection is required to capture actual search, signature, and
structural-search response shapes for final normalization conformance.
