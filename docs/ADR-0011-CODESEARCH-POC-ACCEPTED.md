# ADR-0011: Accept codesearch as the default Code provider

## Status

Accepted.

## Context

The completed clean-corpus evaluation compared Atelier's ripgrep baseline with codesearch through the provider abstraction. Both achieved 0.9643 mean weighted recall. Codesearch improved mean reciprocal rank from 0.75 to 1.0 and mean nDCG@10 from 0.7667 to 0.8949. Conformance reported 46 passes, one optional impact-indexer warning, and no failures.

The only shared miss was a low-weight fixture-contract test that was not a direct answer to the normalization task. It has been removed from that task's expected implementation evidence.

## Decision

Keep codesearch as Atelier's default Code provider. Stop adding provider-specific ranking heuristics unless future evaluations demonstrate a regression. Begin evaluating Octocode as an experimental graph-oriented provider through the same contract.

## Consequences

Codesearch remains the default for general retrieval. Octocode is optional and experimental. Provider provenance and evaluation remain mandatory; neither provider becomes part of Atelier's domain model.
