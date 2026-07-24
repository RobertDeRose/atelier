# Octocode evaluation report

## Decision

Octocode 0.14.0 is not accepted for Atelier's default repository retrieval path. The adapter is
retained as an experimental structural provider.

## Environment

- Repository: Atelier
- Provider: Octocode 0.14.0
- Embeddings: project-local FastEmbed
- Code model: `fastembed:jinaai/jina-embeddings-v2-base-code`
- Text model: `fastembed:nomic-ai/nomic-embed-text-v1.5`
- GraphRAG: enabled without LLM enrichment
- Required MCP contract: fully conforming
- Retrieval tasks: four accepted source, CLI, and normalization queries

## Aggregate results

| Path | Weighted recall | MRR | nDCG@10 | Duration | Bytes |
|---|---:|---:|---:|---:|---:|
| Baseline | 1.0000 | 0.5833 | 0.7093 | 169 ms | 67,036 |
| codesearch | 1.0000 | 1.0000 | 0.9082 | 2,276 ms | 77,624 |
| Octocode | 0.2009 | 0.3750 | 0.2323 | 17,434 ms | 25,360 |

Octocode returned valid evidence and no degraded results, but its candidate set was too narrow
and frequently centered on the Octocode adapter, probe scripts, or captured provider fixtures.
It missed expected companion source and test files that baseline and codesearch found.

## Interpretation

The provider contract is viable, but conformance is not sufficient for default adoption.
Codesearch produced complete recall and substantially better first-hit and ranked relevance.
Octocode's structural capabilities are distinct and remain worth retaining for explicit
relationship, signature, and AST-pattern workflows.

## Promotion gate

Octocode may be reconsidered only after a dedicated structural benchmark demonstrates a
material advantage on impact analysis, architecture navigation, or cross-file relationship
reasoning. General semantic retrieval tuning alone is not a promotion criterion.
