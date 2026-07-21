# Changelog

## 0.8.4 — 2026-07-21

```text
fix(code): repair and verify local vector indexes

- use the bare codesearch index command for local repair and incremental updates
- retain index add only for serve-backed client registration
- verify local HNSW readiness through codesearch statistics
- reject false-ready indexes that contain chunks without a built vector index
- capture vector statistics and store metadata before and after indexing
- require a built vector index in live conformance results
- commit the third real-provider archive as a portable regression fixture
- preserve lexical degradation as a fallback rather than an indexing substitute
```

## 0.8.3 — 2026-07-21

```text
fix(code): preserve retrieval across semantic provider failures

- detect error-bearing MCP text even when providers omit isError
- surface explicit semantic failures instead of returning empty results
- fall back from automatic and hybrid searches to bounded literal retrieval
- mark fallback evidence and provider status as degraded with warnings
- add explicit code-search mode selection to the CLI
- separately probe semantic, hybrid, literal, and automatic search health
- capture codesearch doctor, statistics, direct search, and store metadata
- commit the real vector-store failure as a portable regression fixture
- record degraded results and provider warnings in evaluation reports
```

## 0.8.2 — 2026-07-21

```text
fix(code): preserve failed provider collections

- complete fixture normalization and archive creation after conformance failures
- report the conformance summary and retained nonzero provider status
- treat unavailable optional impact indexing as a warning
- accept structured MCP content when validating fetch and outline responses
- add regressions for failed collection and optional provider capabilities
```

## 0.8.1 — 2026-07-21

```text
fix(code): isolate live providers and strengthen retrieval evaluation

- prevent ordinary tests from launching the real codesearch provider
- add an explicit live codesearch test task
- fail empty fixture imports with actionable guidance
- normalize local provider paths to repository-relative paths
- commit the complete verified codesearch 1.1.30 response fixtures
- separate cold-start latency from steady-state evaluation
- report ranked paths, weighted recall, reciprocal rank, and nDCG
- replace rigid benchmark prompts with weighted retrieval rubrics
- expand conformance checks for fetch, outline, and impact responses
- publish the first evidence-based codesearch evaluation report
```

## 0.8.0 — 2026-07-21

```text
feat(code): complete codesearch conformance and evaluation tooling

- qualify code evidence with indexed and current repository identities
- mark provider evidence stale after working-copy changes
- support optional codesearch impact and outline capabilities
- capture fetch, outline, impact, and MCP schemas in the live probe
- normalize real-provider output into portable test fixtures
- compare baseline ripgrep retrieval with codesearch retrieval
- add a single machine-side knowledge collection workflow
```

## 0.7.1 — 2026-07-21

```text
fix(tooling): harden development checks and codesearch readiness

- make TypeScript 7 load Node declarations explicitly
- pin the mise development toolchain and use a frozen Aube install
- wait for codesearch indexes to become ready before queries
- align local and client routing with the advertised MCP mode
- map hybrid and literal searches to the codesearch 1.1.30 schema
- preserve federated chunk references for fetch-on-demand
- turn the real-provider probe into a conformance test
- stop tracking generated Atelier and codesearch runtime state
```

## 0.7.0 — 2026-07-20

```text
feat(code): prove multi-repository provider workflows

- add explicit multi-repository workspace configuration and validation
- add repository-scoped search, indexing, symbols, and relationships
- enforce provider-neutral result, preview, chunk, fetch, and byte budgets
- preserve compact code evidence in deterministic Working State
- add a repeatable code-intelligence evaluation task set and report format
- add a real codesearch conformance probe with staleness and reindex checks
- extend code diagnostics with workspace mappings and provider state
- keep native parsing, embeddings, ranking, and graph ownership out of Atelier
```
