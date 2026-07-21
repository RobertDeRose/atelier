# ADR-0004: Preserve Code Retrieval During Semantic Provider Failure

## Status

Accepted — 2026-07-21

## Context

A real codesearch 1.1.30 run reported a ready index and functional symbol lookup while
semantic MCP searches returned the text:

```text
Error searching vector store: Error opening database for read fallback
```

The MCP response set `isError: false`. Treating the response as an ordinary empty result
hid the operational failure and caused the comparative evaluation to score semantic
retrieval as zero recall without explaining why.

## Decision

Atelier recognizes error-bearing MCP text as a provider operational failure even when
`isError` is false.

- Explicit `semantic` mode surfaces the error and does not fall back.
- `auto` and `hybrid` modes perform bounded provider-native literal searches.
- Literal results are merged and deduplicated using reciprocal-rank contributions.
- Returned evidence records `actualMode = lexical`, `degraded = true`, the provider error,
  and the fallback post-processing step.
- Provider status remains available but reports the latest degradation warning.
- Live conformance measures semantic, hybrid, and literal health separately.

The fallback uses codesearch's public MCP search tool. Atelier still does not own a code
index, embeddings, AST parser, or vector database.

## Consequences

Agent workflows retain bounded code retrieval when the vector path is unavailable, but
must not mistake fallback results for healthy semantic search. Evaluation reports can
separate retrieval continuity from provider semantic quality. Explicit semantic requests
remain suitable for conformance testing and failure diagnosis.
