# Legacy Decision Record 0009 — Fuse Semantic and Literal Evidence for Focused Retrieval

- Status: Accepted
- Date: 2026-07-22

## Context

The clean-corpus v0.8.7 evaluation confirmed that codesearch semantic retrieval is healthy
and that Atelier's path focus improves implementation discovery. Mean weighted recall rose
from 0.1072 to 0.5625, and an implementation source file ranked first. The remaining misses
were usually companion implementation files containing exact identifiers or command names.
Those files were recoverable through codesearch literal search but absent from the semantic
candidate set consumed by Atelier.

Path classification alone cannot recover evidence the provider never returned. Increasing
semantic overfetch further would consume more bytes while continuing to favor descriptive
documentation. Atelier must not build a native lexical index to solve this.

## Decision

For `auto` and `hybrid` searches resolved to `source` or `tests` focus, Atelier will:

1. Request the bounded semantic candidate pool from codesearch.
2. Derive at most four deterministic literal candidates from quoted fragments,
   code-shaped identifiers, and a small set of workflow-relevant terms.
3. Request no more than twelve compact results per literal candidate.
4. Merge semantic and literal results at repository-path granularity with weighted
   reciprocal-rank fusion.
5. Preserve the provider's original rank separately from Atelier's fused and focused rank.
6. Record whether each result came from semantic, lexical, or both retrieval methods.
7. Apply path focus and final retrieval limits only after fusion.

Explicit `semantic`, explicit `lexical`, neutral `all`, and documentation-focused searches
retain their existing behavior. Literal augmentation failure does not degrade successful
semantic evidence; it is recorded as post-processing rather than presented as semantic
provider failure.

## Consequences

- Focused implementation and test retrieval can recover exact-identifier evidence without
  introducing an Atelier-owned index.
- Results supported by both methods receive stronger ranking evidence.
- Automatic focused searches may perform up to four additional bounded MCP calls.
- `providerRank` remains auditable while `rank` represents Atelier's final orchestration.
- Evaluation and live conformance record the number of semantic-plus-lexical fused results.
- Candidate generation remains deliberately small and deterministic; it is not an
  LLM-generated query expansion system.
