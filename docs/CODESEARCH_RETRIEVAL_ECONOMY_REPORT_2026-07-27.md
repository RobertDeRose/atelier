# Codesearch Retrieval Economy Report — 2026-07-27

## Scope

This report evaluates Atelier's bounded retrieval orchestration against the observed self-hosting planning baseline. It measures repository-intelligence traffic and accepted retrieval recall; it does not claim general autonomous-agent quality.

## Baseline

The reference planning session made 39 repository-intelligence calls: 19 semantic or hybrid searches and 20 symbol searches. It returned 339 results across 58 unique paths. Repetition was concentrated in `docs/IMPLEMENTATION_PLAN.md` (63 appearances), `packages/core/src/core.ts` (46), and the Pi extension and CLI (28 each).

The portable scenario is `evaluation/fixtures/self-hosting-retrieval-economy.json`.

## Deterministic acceptance

`tests/self-hosting-retrieval-acceptance.test.ts` uses a provider-independent fake and the production CodeService, Working State builder, and SQLite ledger.

| Measurement | Result |
|---|---:|
| Repository-intelligence calls | 8 |
| Provider calls | 6 |
| Equivalent canonical provider redispatches | 0 |
| Symbol calls before semantic discovery | 0 |
| Cross-repository leaks | 0 |
| Stale evidence reported current after invalidation | 0 |

The eight-call sequence covers one semantic discovery, one unresolved-symbol lookup, one equivalent Unicode/whitespace query, one known-path direct-read decision, two isolated repository scopes, repository revision invalidation, and index revision invalidation. Repeated Working State construction and ledger reopen add no provider call.

The acceptance also proves that duplicate references are removed before model-facing output, repeated paths consume one unique-path slot, reused evidence retains provider provenance, and telemetry reports cache/reuse behavior, unique paths, duplicate identities removed, bytes returned, truncation, and invalidations.

## Recall gate

`evaluation/fixtures/accepted-codesearch-recall.json` records the accepted codesearch result paths and weighted recall for the original benchmark tasks. `scripts/evaluate-code.ts` now fails when current codesearch weighted recall is lower or any accepted expected path is lost. Baseline, codesearch, and Octocode retain the same scoring functions and report shape.

The ordinary automated suite validates the gate with portable CLI fixtures and does not start live providers.

## Live self-hosting acceptance

The final read-only run used the supported `mise run launch` entry point with only the Atelier extension enabled. It made one focused semantic search, inspected the included inventory, read two returned paths directly, and repeated the query with only leading and trailing ordinary whitespace. It used no shell or broad repository scan and did not call symbols because the inventory listed no unresolved identifier.

| Measurement | Result |
|---|---:|
| Total tool calls, including direct reads | 4 |
| Repository-intelligence calls | 2 |
| Provider calls | 1 |
| Exact cache hits | 1 |
| Unique paths | 10 |
| Bytes returned | 122 |
| Duplicate results removed | 0 |
| Truncated | false |
| Invalidations | 0 |

The second search decision was `exact_reuse` with reason `complete cached result covers requested limit 10`. The provider remained codesearch, the index was ready, inventory freshness was current, and the repository scope contained only `atelier`. Original codesearch provenance remained attached.

A diagnostic first attempt intentionally demonstrated failure safety while the active Pi process still owned the self-contained provider: a second MCP process reported `Error opening readonly database for read fallback`, and Atelier did not fall back to broad scans or label that failed evidence current. The coordinated rerun then succeeded after the owning process closed.

The same indexed workspace passed `mise run evaluate:code`. Every task in the accepted codesearch fixture retained weighted recall 1.0 and every accepted path. The new self-hosting discovery task found five of nine weighted evidence paths in its ten-result model-facing budget (weighted recall 0.65); the aggregate five-task codesearch weighted recall was 0.93. The deterministic acceptance, rather than this single-repository live run, proves multi-repository isolation, bounded restart, duplicate removal, and repository/index invalidation.

## Boundaries

Codesearch remains the default provider. Atelier owns orchestration, budgets, bounded persistence, provenance, scope isolation, reuse, invalidation, and diagnostics. Providers continue to own parsing and indexing. Octocode remains optional and capability-gated. Jujutsu remains the primary repository model, Working State remains authoritative over conversational compaction, and `ManualEdit` remains the user-review lifecycle term.
