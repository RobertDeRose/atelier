# ADR-0021: Reject Octocode for default repository retrieval

- Status: Rejected for default retrieval; retained as experimental structural provider
- Date: 2026-07-23

## Context

Atelier implemented Octocode 0.14.0 behind the provider-neutral MCP contract and completed a
project-local FastEmbed conformance run. The provider advertised and successfully executed
semantic search, signature lookup, structural search, and GraphRAG. Its results were normalized
without degradation or stale-index warnings.

The same four retrieval tasks were then run through baseline direct tools, accepted codesearch,
and Octocode using the public `atlr code search` path.

| Path       | Weighted recall |    MRR | nDCG@10 | Total task time |
|------------|----------------:|-------:|--------:|----------------:|
| Baseline   |          1.0000 | 0.5833 |  0.7093 |          169 ms |
| codesearch |          1.0000 | 1.0000 |  0.9082 |        2,276 ms |
| Octocode   |          0.2009 | 0.3750 |  0.2323 |       17,434 ms |

Octocode frequently returned related Octocode adapter and probe files instead of the expected
provider-selection, CLI, codesearch implementation, and normalization-test evidence.

## Decision

Do not use Octocode as Atelier's default general-purpose repository retrieval provider.
Codesearch remains the accepted default.

Retain the Octocode adapter as an explicit experimental structural provider for signatures,
AST structural search, GraphRAG relationships, and future impact-analysis benchmarks. Do not
add provider-specific ranking heuristics to make Octocode imitate codesearch without evidence
from a dedicated structural workflow evaluation.

## Consequences

- `codeProvider` continues to default to `codesearch`.
- Users may explicitly select `--provider octocode` or configure it for experiments.
- Octocode remains in the development toolchain so its structural contract can be tested.
- Comparative retrieval below baseline is recorded as a warning, not a provider-contract failure.
- Future promotion requires a new benchmark showing material value on structural or impact tasks.
- Atelier still does not own a native parser, embedding index, or code graph.
