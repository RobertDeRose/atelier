# Changelog

## 0.14.0-alpha.4 — 2026-07-28

- compare `/atelier-trust` notifications with Atelier's canonical trust identity instead of a
  noncanonical temporary-directory alias
- add a platform-independent repository-symlink regression so Linux CI exercises the same identity
  behavior as macOS `/var` to `/private/var` resolution
- preserve the production trust behavior; this release corrects the alpha.3 test expectation that failed on macOS

## 0.14.0-alpha.3 — 2026-07-27

- rename Atelier's Pi trust command from `/trust` to `/atelier-trust` so it no longer collides with Pi's built-in project-trust command
- preserve `atlr trust ...` for CLI trust management and document the distinct Pi and Atelier trust boundaries
- add a regression assertion that the extension never registers Pi's reserved `/trust` command

## 0.14.0-alpha.2 — 2026-07-27

```text
fix(test): canonicalize plan-review path expectations

- preserve real-path canonicalization for trusted repository and plan paths
- assert ManualEdit changed paths against Atelier's canonical configured plan path
- add a repository-alias regression covering macOS /var to /private/var behavior
- run deterministic CI on Ubuntu 24.04 and macOS 26
```

## 0.14.0-alpha.1 — 2026-07-27

```text
fix(safety): make reviewed execution truthful and fail closed

- require external project trust before repository-controlled commands can start
- move runtime state outside the repository and make doctor observational
- treat generic shell as unconfined, single-operation approval only
- add symlink-safe typed path confinement and an adversarial command corpus
- bind exact approval to source, every workspace root, retrieval revisions, and typed capabilities
- atomically install task capabilities while excluding arbitrary shell execution
- enforce required validation, exact final-diff review, a local change, and clean closure state
- make Git/Jujutsu observation failure explicit and include staged/untracked Git evidence
- isolate Pi sessions and await asynchronous provider shutdown
- emit stable JavaScript/declarations, unify release metadata, and add deterministic/live CI gates
- correct ADR identifiers and document all 29 review recommendations
```

## 0.13.0 — 2026-07-27

```text
feat(workflow): prove exact local execution end to end

- open initial plan drafts in the configured foreground editor and persist ManualEdit diffs
- require exact plan hash, provider reconciliation digest, and explicit approval before mutation
- reconcile create, adopt, update, dependency link/unlink, and retirement idempotently
- bind act mode to one approved-plan task/workspace without implying action permissions
- persist post-tool success, failure, interruption, snapshots, and observed changed paths
- select focused validation with reasons and reject stale passes at task closure
- reconstruct approval, task, grants, mutation evidence, validation, and next action after restart
- add explicit execute and cancel flows to both CLI and Pi
- add portable end-to-end and smoke-cleanup acceptance without live optional services
- document authority boundaries, migration preservation, and the disposable Jujutsu launch gate
```

## 0.12.0 — 2026-07-27

```text
feat(retrieval): bound and prove self-hosting evidence reuse

- enforce one semantic discovery before unresolved exact-symbol lookup
- reuse equivalent canonical queries and known paths without provider dispatch
- isolate repository scopes and invalidate overlapping repository/index bindings
- preserve historical provenance without reporting invalid evidence as current
- report calls, cache hits, overlap reuse, unique paths, deduplication, bytes,
  truncation, invalidations, and repository scopes
- gate codesearch evaluation against every accepted expected path and recall score
- add a portable eight-call self-hosting scenario and provider-independent acceptance
- verify the supported launch flow with one provider call and one exact cache hit
```

## 0.11.0 — 2026-07-26

```text
feat(workflow): make approved local execution usable

- persist restart-safe workflow and ManualEdit lifecycle records
- add deterministic structural plan snapshots and diffs
- migrate the ledger atomically to workflow schema version 2
- default routine approved-task work inside the active repository to allowed
- distinguish routine, destructive, external, and unknown command effects
- retain approval for destructive commands, publication, external effects,
  unknown commands, and explicit paths outside the repository
- classify mise validation, local runtimes, Git commits, and normal Jujutsu
  operations as routine execution
- add an act-mode completion guard for validated but uncommitted task work
- add focused policy, classifier, Pi, review, migration, and recovery tests
```

## 0.10.7 — 2026-07-26

```text
fix(plan): start slash-command planning immediately

- remove the unresolved waitForIdle boundary from /plan
- rely on Pi's command boundary before sending the planning message
- preserve objectives supplied as /plan <context>
- add a regression with a deliberately unresolved idle promise
```

## 0.10.6 — 2026-07-26

```text
fix(code): coordinate background indexing in Pi

- start code indexing in the background when a Pi session launches
- coalesce startup, command, and concurrent index requests into one operation
- make searches, symbol lookup, and relationships wait for active indexing
- prevent status checks from reconnecting MCP while the local writer is active
- show building, ready, and failed index state in the Pi footer
- route /code-index through the same lifecycle
- record completed and failed indexing outcomes in the ledger
- add focused concurrency and waiting regressions
```

## 0.10.5 — 2026-07-25

```text
fix(plan): activate provider tools for agent turns

- explicitly add Atelier code tools to Pi's active tool set
- prioritize code search and symbol lookup before generic Bash/read tools
- converge activation on session start, plan entry, and every agent turn
- name the active tools directly in the plan instruction
- retain approval-free exact reads and read-only shell commands
- block the exact broad find/rg commands observed in the live demo session
- add active-tool and live-command regressions
```

## 0.10.4 — 2026-07-25

```text
fix(plan): allow reads and enforce provider-first discovery

- classify compound shell commands segment by segment
- allow read-only pipelines, command chains, and safe /dev/null sinks without approval
- preserve mutation gates for redirection, find write actions, and nested mutating execution
- expose Atelier code status, search, and symbol lookup as agent-callable Pi tools
- require provider-first repository discovery in plan mode
- allow raw grep/find/rg/ls fallback only after unavailable, degraded, failed, or empty provider evidence
- add regressions derived from the failing live planning session
```

## 0.10.3 — 2026-07-25

```text
fix(shell): normalize Bun SQLite missing rows

- normalize bun:sqlite Statement.get() null results to undefined
- preserve node:sqlite missing-row behavior
- make ledger state and task-mapping reads null-safe
- keep the existing database schema and persisted state unchanged
- add a Bun missing-row regression at the runtime boundary
- retain dual-runtime and launcher regressions
```

## 0.10.2 — 2026-07-25

```text
fix(shell): support Pi's Bun SQLite runtime

- detect the actual Bun extension runtime used by Pi
- select bun:sqlite in Bun and node:sqlite in Node
- preserve the existing SQLite schema and synchronous ledger API
- avoid static SQLite built-in imports in the Pi dependency graph
- canonicalize repository roots before launch on macOS
- add Bun selection, Node fallback, and canonical launcher regressions
- supersede the Node-only runtime assumption in ADR-0014
```

## 0.10.1 — 2026-07-25

```text
fix(shell): make the Pi extension launchable

- replace static node:sqlite imports with runtime built-in resolution
- preserve the existing SQLite ledger and database format
- add an actionable runtime compatibility error
- add atlr launch and mise run launch as supported Pi entry points
- forward Pi arguments unchanged from the Atelier launcher
- add SQLite-loader and launcher regression tests
```

## 0.10.0 — 2026-07-23

```text
feat(state): integrate retrieval into task-backed Working State

- persist the planning objective as durable Atelier state
- retrieve code evidence during planning before a provider task exists
- add a deterministic repository-state planner with bounded exact identifier hints
- scope ready-task selection to the approved plan and record selection rationale
- reconstruct direct dependencies, blockers, corrections, findings, and Manual Edits
- preserve durable current-task state across transient provider failures
- record retrieval queries, degradation, warnings, and result counts in Working State
- commit the missing Octocode 0.14.0 mise lock entry
```

## 0.9.8 — 2026-07-23

```text
docs(code): decide the Octocode provider role

- preserve the complete baseline/codesearch/Octocode comparison fixture
- accept codesearch as the continuing default retrieval provider
- reject Octocode for default semantic repository retrieval
- retain Octocode for explicit signatures, structural search, and GraphRAG experiments
- record the provider decision and structural promotion gate in ADR-0021
- stop the Octocode ranking-repair loop without new workflow evidence
```

## 0.9.7

```text
feat(code): compare Octocode with accepted retrieval paths

- preserve the fully conforming Octocode 0.14.0 live run
- generalize evaluation across baseline, codesearch, and Octocode
- retain provider-native and final ranking evidence per result
- refresh both indexes before comparative live evaluation
- report incomplete comparisons as failures and weak quality as warnings
- add dedicated Octocode and all-provider evaluation tasks
```

## 0.9.6

```text
fix(code): normalize Octocode text MCP responses

- parse semantic search text into normalized repository hits
- retry symbol lookup with signature detail and a zero similarity threshold
- parse signature and GraphRAG text into provider-neutral evidence
- call GraphRAG with the advertised operation schema
- preserve the successful local FastEmbed run as a regression fixture
```

## 0.9.5 — 2026-07-23

```text
fix(code): use the supported Octocode index lifecycle

- remove the unsupported Octocode index --force argument
- write and verify the project-local FastEmbed configuration directly
- preserve unmanaged project-local Octocode configuration
- retry zero-block indexes through the documented bare index command
- capture the failed force-based live run as a portable regression fixture
```

## 0.9.4 — 2026-07-23

```text
fix(code): configure project-local Octocode embeddings

- create an isolated Atelier Octocode configuration under .atelier
- use local FastEmbed code and text models without cloud API keys
- enable non-LLM GraphRAG for structural relationships
- pass OCTOCODE_CONFIG_PATH to every Octocode subprocess
- force the first rebuild when an existing index contains no blocks
```

## 0.9.3

```text
fix(code): harden Octocode embedding preflight and live collection

- clamp semantic search requests to the provider-advertised maximum
- reject missing cloud embedding credentials before long indexing runs
- verify indexing produced searchable blocks before reporting ready
- preserve MCP tool discovery when individual tool calls fail
- capture configuration, model support, and redacted key presence
- treat absent GraphRAG as a capability warning
- preserve the verified Octocode 0.14.0 MCP schema as a regression fixture
```

## 0.9.2

```text
fix(code): align Octocode adapter with live MCP contract

- fix collector positional argument ordering
- call semantic search, signatures, and structural tools directly
- gate GraphRAG relationships on advertised capabilities
- send query arrays and the documented max_results/detail_level fields
- map source and documentation focus to Octocode content modes
- allow long-running first-time Octocode indexing
- ignore generated Octocode indexes and probe artifacts
- preserve the verified Octocode 0.14.0 MCP contract as a regression fixture
```

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
