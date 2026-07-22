# Changelog

## 0.9.1

```text
fix(code): provision and stabilize Octocode development integration

- install Octocode 0.14.0 through the mise development manifest
- compare canonical repository paths in multi-repository process tests
- diagnose a missing Octocode executable before invoking probe commands
- document platform-specific embedding-provider configuration
```

## 0.9.0 — 2026-07-22

```text
feat(code): add experimental Octocode provider

- accept codesearch as the default after matching baseline recall with better ranking
- add an Octocode MCP adapter behind the existing Code provider contract
- route multi-repository workspaces through one Octocode process per repository
- discover semantic, signature, graph, and structural capabilities at runtime
- add safe direct source fetching for local Octocode references
- add live Octocode MCP and indexing collection scripts
- correct the normalization benchmark to measure direct implementation evidence
```

## 0.8.9 — 2026-07-22

```text
fix(code): constrain lexical fusion to exact identifiers

- accept explicit exact identifier hints through the provider-neutral query model and CLI
- stop augmenting healthy semantic retrieval with generic workflow nouns
- retain broad literal term extraction only for degraded semantic fallback
- infer mixed implementation-and-test focus for questions requesting both evidence classes
- interleave source and test paths while preserving provider order within each class
- pass benchmark literals as exact provider hints and record hint usage in evaluation
- commit the 0.8571 weighted-recall fusion run as a portable pre-hint regression fixture
```

## 0.8.8 — 2026-07-22

```text
feat(code): fuse semantic and literal focused retrieval

- augment focused automatic and hybrid searches with bounded literal provider queries
- derive deterministic candidates from code-shaped identifiers and workflow terms
- merge semantic and lexical results with weighted reciprocal-rank fusion
- preserve provider rank while assigning Atelier orchestration rank separately
- record semantic, lexical, or combined retrieval methods on every result
- leave explicit semantic, explicit lexical, documentation, and neutral searches unchanged
- add fused-result metrics to comparative evaluation and live conformance
- commit the 0.5625 weighted-recall run as a portable pre-fusion regression fixture
```

## 0.8.7 — 2026-07-22

```text
feat(code): focus provider retrieval on workflow evidence

- add automatic and explicit source, tests, docs, and all search focus
- overfetch a bounded compact provider candidate pool before final truncation
- preserve provider rank and score through Atelier post-processing
- prioritize workflow-relevant path classes while retaining provider order within each class
- diversify files before returning duplicate chunks from the same path
- apply the same focus policy to the ripgrep evaluation baseline
- record provider order, resolved focus, and reranking in evaluation reports
- warn in live conformance when implementation focus or weighted recall remains weak
- commit the clean 2,138-chunk codesearch corpus as a portable regression fixture
```

## 0.8.6 — 2026-07-22

```text
fix(code): exclude captured evidence from repository retrieval

- add a repository-local codesearch corpus-selection manifest
- exclude real-provider response fixtures and generated knowledge archives
- fingerprint ignore inputs and provider version for local index selection
- force one rebuild when the selected corpus changes
- retain incremental indexing while the selection fingerprint is unchanged
- make the ripgrep baseline consume the same codesearch ignore file
- fail live conformance when ignored fixture paths leak into results
- compact captured evaluation fixtures by removing raw stdout and stderr payloads
- commit the successful vector-repair run as a portable regression fixture
```

## 0.8.5 — 2026-07-21

```text
fix(code): release MCP writer before local indexing

- stop and await the self-contained MCP subprocess before local repair
- prevent Tantivy LockBusy failures caused by competing Atelier-owned processes
- reconnect to MCP only after codesearch stats confirms HNSW readiness
- wait for graceful provider exit with a bounded SIGKILL fallback
- retain serve-backed client registration without disrupting the remote service
- commit the fourth real-provider archive as a portable writer-lock fixture
- add a regression that fails whenever indexing starts while MCP holds the writer
```

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
