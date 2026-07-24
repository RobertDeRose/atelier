# Octocode comparative evaluation

## Purpose

Octocode passed Atelier's provider conformance gate with project-local FastEmbed embeddings and non-LLM GraphRAG. The remaining question is not whether the adapter works, but whether Octocode improves agentic retrieval enough to justify an ongoing integration.

## Comparison boundary

The evaluator sends every task through the same public interface:

```text
atlr code search <query> --provider <provider> --mode auto --focus <focus>
```

The comparison includes:

- a direct ripgrep baseline using the same repository exclusion manifest;
- the accepted codesearch provider;
- the experimental Octocode provider.

All methods use the same task definitions, expected paths, relevance weights, repository selection, and workflow focus. Provider-specific output is normalized before scoring.

## Metrics

Each task records:

- weighted recall;
- reciprocal rank;
- nDCG@10;
- final and provider-native path order;
- duration and output bytes;
- degraded-result and warning counts;
- focus and reranking provenance.

The aggregate report retains provider-keyed metrics and backward-compatible direct `codesearch` and `octocode` fields.

## Commands

```bash
mise run evaluate:code:octocode
mise run evaluate:code:all
mise run collect:octocode
```

`collect:octocode` refreshes both indexes, captures the complete MCP contract, runs the three-way evaluation, writes `.atelier/octocode-probe/evaluation/latest.json`, and packages all evidence in `atelier-octocode-knowledge.tar.xz`.

## Decision gate

Contract or evaluation completeness failures fail conformance. Octocode retrieval below the baseline is recorded as a warning while evidence is gathered. The next live report will determine whether Octocode should:

1. remain an experimental provider;
2. become an optional structural/graph companion to codesearch; or
3. be rejected as an integration target.

Codesearch remains the default until that decision is recorded explicitly.
