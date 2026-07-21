# Atlr Code Intelligence Integration

## Status

Codesearch adapter implemented in Atelier v0.6.0 and hardened against live codesearch 1.1.30 behavior in v0.7.1; Octocode integration and comparative evaluation remain proposed.

## Purpose

Atlr needs repository intelligence that helps agents locate implementations, understand relationships, retrieve relevant context, and reason across repositories.

The first implementation should integrate existing code-intelligence systems rather than build a new indexing engine. The proof of concept must validate whether code intelligence materially improves agent outcomes before Atlr commits to owning parsing, indexing, embedding generation, vector storage, ranking, graph construction, and incremental-update infrastructure.

The initial providers are:

- `codesearch`
- `Octocode`

Both should be treated as external, replaceable integration points behind an Atlr-owned capability interface.

## Decision

Implement support for both providers, sequentially:

1. Integrate `codesearch` as the first and default proof-of-concept provider.
2. Add `Octocode` as a second experimental provider through the same Atlr abstraction.
3. Evaluate both against a baseline using repeatable agent tasks.
4. Build native Atlr indexing components only when evaluation identifies concrete requirements that neither provider can satisfy.

Atlr must not directly expose either provider's internal storage model or make either provider's MCP tool names part of its core domain model.

## Why Integrate Before Building

A native implementation would require Atlr to own:

- Source discovery and ignore rules
- Language detection
- Tree-sitter parser management
- AST-aware chunking
- Symbol extraction
- Incremental indexing
- Lexical indexing
- Embedding generation
- Vector indexing
- Hybrid ranking
- Graph construction
- Index invalidation
- Branch and revision awareness
- Persistence
- Migration and compatibility
- Resource management
- Search-quality benchmarking

That work would not validate Atlr's primary product hypothesis.

The proof of concept should instead validate whether Atlr can:

- Discover and manage a repository-intelligence provider.
- Expose a stable agent-facing interface.
- Use retrieval without flooding the agent context.
- Preserve evidence and provenance.
- Handle provider failures and stale indexes.
- Compare provider quality objectively.
- Combine code intelligence with Atlr-owned project state.

## Provider Roles

### codesearch

Use `codesearch` as the first provider because it appears to offer the smaller and more direct integration surface for a local agent workflow.

Expected strengths:

- Local and offline operation
- CPU-oriented deployment
- Multi-repository indexing
- Tree-sitter-aware chunking
- Lexical and semantic retrieval
- Hybrid ranking
- Symbol-oriented navigation
- Incremental indexing
- MCP interface
- Metadata-first retrieval followed by targeted source fetching

The first integration should prioritize proving the basic Atlr workflow:

1. Start or connect to the provider.
2. Ensure the current workspace is indexed.
3. Search using natural language or identifiers.
4. Return concise ranked metadata.
5. Fetch full source only for selected results.
6. Record provenance in the agent session.

### Octocode

Use Octocode as the second provider to test richer structural retrieval.

Expected strengths:

- Semantic and hybrid search
- Structural code relationships
- Dependency, import, or call relationships
- Graph-based retrieval
- Reranking
- Branch-aware or revision-sensitive behavior
- Incremental indexing
- MCP interface
- Broader code-intelligence and GraphRAG concepts

The Octocode integration should answer a different question from the first provider:

> Do graph and relationship-aware results materially improve an agent's ability to understand impact, architecture, and cross-file behavior?

Do not force Octocode's advanced capabilities into the minimum common interface. Expose them through optional capability discovery.

## Architecture

```text
Atlr agent or workflow
        |
        v
Atlr repository-intelligence service
        |
        +-- provider registry
        |
        +-- capability negotiation
        |
        +-- normalized result model
        |
        +-- codesearch adapter
        |
        +-- Octocode adapter
        |
        +-- future native or third-party adapters
```

The repository-intelligence service is owned by Atlr. Providers remain external processes.

## Integration Boundary

Use MCP as the initial process and protocol boundary.

Do not initially:

- Link either provider as a Rust library.
- Depend on provider database schemas.
- Read provider index files directly.
- Re-export provider-specific MCP methods as Atlr's public contract.
- Couple Atlr lifecycle rules to undocumented provider behavior.

The MCP subprocess boundary provides:

- Independent installation and upgrades
- Failure isolation
- Provider replacement
- Compatibility with agent tooling
- A realistic test of Atlr's external-tool orchestration
- Reduced dependency and build complexity

An adapter may use stdio MCP or another provider-supported local MCP transport. Transport details must remain below the Atlr repository-intelligence interface.

## Core Domain Interface

The exact Rust design may change during implementation, but the Atlr-owned interface should resemble the following:

```rust
pub trait RepositoryIntelligence: Send + Sync {
    async fn capabilities(
        &self,
    ) -> Result<ProviderCapabilities, RepositoryIntelligenceError>;

    async fn ensure_index(
        &self,
        workspace: &WorkspaceIdentity,
    ) -> Result<IndexStatus, RepositoryIntelligenceError>;

    async fn search(
        &self,
        query: SearchQuery,
    ) -> Result<Vec<SearchHit>, RepositoryIntelligenceError>;

    async fn read(
        &self,
        reference: CodeReference,
    ) -> Result<CodeChunk, RepositoryIntelligenceError>;

    async fn find_symbols(
        &self,
        query: SymbolQuery,
    ) -> Result<Vec<SymbolHit>, RepositoryIntelligenceError>;

    async fn relationships(
        &self,
        query: RelationshipQuery,
    ) -> Result<Vec<CodeRelationship>, RepositoryIntelligenceError>;
}
```

Do not require every provider to implement every operation. Unsupported capabilities must return a typed unsupported-capability result or be prevented through capability negotiation.

## Capability Model

At minimum, support capability identifiers such as:

```text
index.repository
index.multi_repository
index.incremental
index.revision_aware

search.lexical
search.semantic
search.hybrid

symbol.search
symbol.definition
symbol.references

graph.relationships
graph.imports
graph.calls
graph.dependencies

result.fetch_on_demand
result.rerank
```

Capabilities should be data, not hard-coded provider checks spread across the codebase.

Example:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RepositoryIntelligenceCapability {
    RepositoryIndex,
    MultiRepositoryIndex,
    IncrementalIndex,
    RevisionAwareIndex,
    LexicalSearch,
    SemanticSearch,
    HybridSearch,
    SymbolSearch,
    SymbolDefinition,
    SymbolReferences,
    Relationships,
    ImportGraph,
    CallGraph,
    DependencyGraph,
    FetchOnDemand,
    Reranking,
}
```

## Workspace Identity

Every request must identify the workspace and revision context clearly.

A workspace identity should include:

- Stable Atlr workspace identifier
- Repository root
- Repository name
- Version-control system
- Current revision identifier
- Current working-copy identifier when available
- Optional branch or bookmark
- Optional multi-repository workspace identifier

Atlr is centered on Jujutsu. The abstraction must therefore avoid Git-only assumptions.

For a Jujutsu workspace, retain at least:

- Repository root
- Working-copy commit ID
- Parent commit ID or IDs
- Active bookmark when present
- Dirty or modified working-copy state
- Workspace name when multiple Jujutsu workspaces exist

A provider may only understand the checked-out filesystem. Atlr must still preserve the Jujutsu identity in its own request and provenance records.

## Search Query Model

A normalized query should support:

```rust
pub struct SearchQuery {
    pub workspace: WorkspaceIdentity,
    pub text: String,
    pub mode: SearchMode,
    pub scopes: Vec<SearchScope>,
    pub languages: Vec<String>,
    pub path_filters: Vec<PathFilter>,
    pub limit: usize,
    pub include_tests: bool,
    pub include_generated: bool,
}

pub enum SearchMode {
    Auto,
    Lexical,
    Semantic,
    Hybrid,
}
```

The adapter maps this model onto the subset supported by the provider.

Unsupported filters must not be silently ignored. The adapter should either:

- Apply the filter locally after retrieval.
- Report that it was not enforced.
- Reject the request when omission would make the result misleading.

## Normalized Search Results

Every result should preserve enough information for the agent to assess and fetch it without receiving entire files immediately.

```rust
pub struct SearchHit {
    pub provider: ProviderIdentity,
    pub workspace: WorkspaceIdentity,
    pub repository: String,
    pub revision: Option<String>,
    pub path: PathBuf,
    pub line_range: Option<LineRange>,
    pub symbol: Option<SymbolIdentity>,
    pub language: Option<String>,
    pub retrieval_methods: Vec<RetrievalMethod>,
    pub rank: usize,
    pub provider_score: Option<f64>,
    pub summary: Option<String>,
    pub preview: Option<String>,
    pub reference: CodeReference,
    pub provenance: RetrievalProvenance,
}
```

`provider_score` must not be treated as comparable across providers unless Atlr explicitly normalizes it. Rank and evaluation outcomes are safer comparison inputs.

## Provenance

Every returned result must record:

- Provider name and version
- Provider instance
- Workspace
- Revision or filesystem state
- Query
- Search mode requested
- Search mode actually used
- Provider reference
- Retrieval timestamp
- Index status or age when available
- Filters requested
- Filters actually enforced
- Reranking status
- Any adapter-side post-processing

The agent should be able to state where evidence came from and whether the index may be stale.

## Retrieval Workflow

Prefer a staged retrieval workflow:

```text
search
  |
  v
ranked metadata and small previews
  |
  v
agent selects likely results
  |
  v
fetch exact code chunks
  |
  v
follow symbols or relationships as needed
```

Do not eagerly return large source files or dozens of full chunks.

The adapter or repository-intelligence service should enforce configurable limits for:

- Number of search results
- Preview size
- Full chunk size
- Number of follow-up fetches
- Relationship traversal depth
- Total retrieved bytes
- Total estimated tokens

## Provider Configuration

Use Atlr configuration rather than provider-specific code paths in workflows.

Example:

```toml
[code_intelligence]
enabled = true
default_provider = "codesearch"
fallback_provider = "octocode"

[code_intelligence.providers.codesearch]
enabled = true
transport = "stdio"
command = "codesearch"
args = ["mcp", "serve"]

[code_intelligence.providers.octocode]
enabled = true
transport = "stdio"
command = "octocode"
args = ["mcp"]
experimental = true
```

The exact commands must be confirmed against the installed provider versions during implementation. Do not copy assumed commands into production without verification.

Support environment overlays and project-local configuration without committing machine-specific executable paths.

## Provider Registry

Implement a registry that:

- Loads enabled providers.
- Validates configuration.
- Starts or connects to providers lazily.
- Performs MCP initialization.
- Detects capabilities.
- Records provider versions.
- Tracks health.
- Selects the configured default.
- Supports explicit provider selection.
- Supports controlled fallback.

Do not silently switch providers in a way that hides materially different semantics. A fallback result must identify the provider that actually served it.

## Lifecycle

The proof of concept should support:

1. Provider discovery.
2. Configuration validation.
3. Lazy process startup.
4. MCP handshake.
5. Capability discovery.
6. Workspace registration or indexing.
7. Search and fetch.
8. Graceful shutdown.
9. Process termination after timeout.
10. Recovery after provider crash.

Atlr should not assume an index is ready merely because the provider process is running.

Model index state explicitly:

```rust
pub enum IndexState {
    Missing,
    Building,
    Ready,
    Stale,
    Failed,
    Unknown,
}
```

## Staleness and Working-Copy Changes

The proof of concept must test edits made after initial indexing.

Atlr should distinguish:

- Provider reports index current.
- Provider reports index stale.
- Atlr knows files changed but provider has not confirmed an update.
- Provider exposes no staleness information.

When Atlr detects changes through Jujutsu state or filesystem observation, it should request an incremental update when supported.

Search results from a potentially stale index must carry that warning. The agent may then verify critical evidence using direct file reads.

## Manual Edited State

The project uses the term **Manual Edited** for artifacts that users may modify directly.

Code intelligence must never overwrite Manual Edited artifacts.

When Atlr later indexes plans, task metadata, decisions, transcripts, or other project artifacts, the index may consume Manual Edited content as evidence, but the provider must remain read-only with respect to those files unless a separate approved workflow explicitly performs edits.

## Failure Handling

Provider failures must produce typed errors, including:

- Provider unavailable
- Process launch failed
- MCP initialization failed
- Unsupported capability
- Workspace registration failed
- Index missing
- Index stale
- Index build failed
- Query rejected
- Query timed out
- Invalid provider response
- Provider crashed
- Result reference expired
- Source fetch failed

Error messages should include actionable provider context while avoiding leakage of secrets or excessive subprocess output.

## Security and Trust

Treat all provider output as untrusted structured data.

The adapter must:

- Validate MCP responses.
- Bound payload sizes.
- Normalize paths.
- Reject paths outside registered repositories unless explicitly allowed.
- Avoid shell interpolation.
- Pass command arguments as an argument vector.
- Redact configured secrets from logs.
- Record provider executable and version.
- Avoid automatically executing commands suggested by search results.
- Treat generated summaries as claims requiring source verification.

Search results are evidence candidates, not authority.

## Proof-of-Concept Scope

### In Scope

- Provider registry
- MCP subprocess transport
- `codesearch` adapter
- Octocode adapter
- Capability negotiation
- Workspace registration
- Index readiness checks
- Search
- Fetch-on-demand
- Symbol search where supported
- Relationship retrieval where supported
- Provenance
- Staleness reporting
- Basic health and diagnostic commands
- Evaluation harness
- Configuration
- Documentation

### Out of Scope

- Native Atlr embeddings
- Native vector database
- Native BM25 index
- Native Tree-sitter parsing
- Native code graph
- Distributed indexing
- Cloud-hosted index service
- Automatic model-generated descriptions of every symbol
- Cross-user shared indexes
- Replacing LSP
- Replacing direct source reads
- Editing code through the provider
- Deep provider-specific UI

## Suggested Atlr Commands

The exact command hierarchy should follow Atlr's existing command conventions. Candidate commands are:

```text
atlr intelligence providers
atlr intelligence status
atlr intelligence index
atlr intelligence search
atlr intelligence symbols
atlr intelligence related
atlr intelligence doctor
```

Corresponding slash commands should use the same names without an `atlr-` prefix, consistent with the project naming decision.

Examples:

```text
/intelligence-search
/intelligence-status
/intelligence-related
```

Do not introduce a slash command for every low-level provider operation. Agent workflows should normally call the repository-intelligence service directly.

## Diagnostics

`atlr intelligence doctor` should report:

- Configured providers
- Default provider
- Executable resolution
- Provider version
- MCP handshake status
- Advertised capabilities
- Registered repositories
- Index state
- Last successful index update
- Last query status
- Known stale workspaces
- Relevant resource usage when available

Diagnostics must not mutate indexes unless explicitly requested.

## Evaluation Plan

The proof of concept must compare:

1. Baseline agent tools
2. Atlr with `codesearch`
3. Atlr with Octocode

The baseline should include normal direct tools such as:

- `rg`
- File listing
- File reads
- LSP operations where available

Use the same repository state, task prompt, agent model, system instructions, and tool budget for each run where practical.

### Repository Set

Use at least:

- One medium-sized single repository
- One multi-repository workspace
- One repository with a recent unindexed working-copy change
- Preferably one mixed-language repository

### Task Set

Include tasks such as:

1. Locate where a behavior is implemented from a natural-language description.
2. Find an exact symbol and its definition.
3. Trace a command or API from entry point to implementation.
4. Identify likely callers or dependents affected by a change.
5. Explain a workflow spanning multiple files.
6. Explain a workflow spanning multiple repositories.
7. Find an existing implementation pattern suitable for reuse.
8. Locate relevant tests for an implementation.
9. Detect an architectural dependency that plain text search misses.
10. Re-run a query after modifying the working copy.

### Measurements

Record:

- Final-answer correctness
- Implementation correctness when code changes are involved
- Relevant files discovered
- Important files missed
- False-positive files
- Time to first useful evidence
- Total task duration
- Tool-call count
- Search-call count
- Source-fetch count
- Input and output token estimates
- Bytes retrieved
- Index build time
- Incremental update time
- Index disk usage
- Peak memory where practical
- Provider failures
- Stale-index incidents
- Agent overreliance on incorrect retrieval
- Number of direct reads needed to verify results

### Success Criteria

The integration is useful when at least one provider demonstrates repeatable improvement in meaningful agent tasks without unacceptable operational cost.

Potential proof-of-concept success criteria:

- Higher task correctness than baseline
- Faster discovery of the primary implementation files
- Fewer irrelevant full-file reads
- Lower context consumption
- Better cross-file or cross-repository explanations
- Reliable index refresh after edits
- Predictable local resource use
- Recoverable provider failures
- No coupling of Atlr's domain model to one provider

Do not declare success based only on attractive search examples.

## Implementation Phases

### Phase 1: Common Foundation

Implement:

- Domain types
- Capability model
- Provider registry
- MCP client abstraction
- Process lifecycle
- Configuration
- Provenance
- Typed errors
- Mock provider for tests

Exit criteria:

- A fake MCP provider can be registered.
- Atlr can negotiate capabilities.
- Atlr can execute search and fetch operations.
- Errors and provenance are preserved.

### Phase 2: codesearch Adapter — Implemented in v0.6.0, hardened in v0.7.1

Implemented:

- Provider discovery
- Version detection
- MCP startup
- Capability mapping
- Workspace indexing
- Search mapping
- Result normalization
- Source fetching
- Staleness behavior
- Provider diagnostics

Exit criteria:

- An agent can search and fetch code from an indexed repository.
- Multi-repository behavior is exercised if supported.
- Results include provenance.
- Provider crashes are recoverable.
- Working-copy changes are tested.

### Phase 3: Octocode Adapter

Implement:

- MCP startup and capability mapping
- Search mapping
- Symbol mapping
- Relationship mapping
- Graph or structural queries
- Result normalization
- Provider diagnostics

Exit criteria:

- Octocode works through the same common search interface.
- Optional graph capabilities are exposed without polluting the common minimum.
- The agent can request relationships when advertised.
- Provider-specific data remains inside the adapter.

### Phase 4: Comparative Evaluation

Implement or run:

- Fixed repository fixtures
- Fixed task prompts
- Baseline runs
- codesearch runs
- Octocode runs
- Metrics capture
- Human review rubric
- Comparative report

Exit criteria:

- Results are reproducible enough to support a design decision.
- Limitations are tied to concrete failed or degraded tasks.
- Resource costs are recorded.
- Follow-up work is prioritized from evidence.

### Phase 5: Product Decision

Choose among:

- Keep `codesearch` as default.
- Keep Octocode as default.
- Support both for different capabilities.
- Keep one and remove the other.
- Contribute missing features upstream.
- Build a narrow native Atlr component.
- Build a full native backend only if justified.

## Native Atlr Work: Decision Gate

Do not begin a native indexing engine merely because Atlr could implement one.

A native component is justified only when all of the following are true:

1. The limitation affects important Atlr workflows.
2. The limitation is demonstrated by evaluation.
3. Neither provider supports it adequately.
4. An upstream contribution or adapter workaround is insufficient.
5. Atlr can define ownership and maintenance boundaries.
6. The expected benefit exceeds the operational complexity.

Likely areas where Atlr may eventually need native ownership include:

- Jujutsu revision and working-copy semantics
- Mapping evidence to Atlr tasks and plans
- Agent transcript indexing
- Validation and test-result indexing
- Manual Edited artifact provenance
- Unified code, documentation, task, and decision relationships
- Cross-repository project topology
- Retrieval policies tied to workflow state

These do not require Atlr to own general-purpose code embeddings immediately.

## Testing Strategy

### Unit Tests

Test:

- Capability mapping
- Configuration parsing
- Provider selection
- Fallback rules
- Path normalization
- Result normalization
- Provenance
- Score preservation
- Unsupported operations
- Error translation
- Payload limits

### Contract Tests

Create provider-independent tests that every adapter must satisfy:

- Startup and handshake
- Capability discovery
- Workspace registration
- Search returns normalized hits
- References can be fetched
- Invalid references fail cleanly
- Timeouts are enforced
- Process death is detected
- Shutdown is clean
- Paths cannot escape the workspace

### Integration Tests

Run against pinned provider versions.

Tests should be skippable when provider binaries or required models are unavailable, but skips must be explicit and reported as unavailable rather than passing silently.

Avoid downloading large embedding models during normal unit-test execution.

### Evaluation Tests

Keep evaluation separate from correctness tests. Search relevance can vary by provider version, model, and index state.

Store:

- Repository revision
- Provider version
- Embedding model when applicable
- Configuration
- Prompt
- Raw normalized results
- Final agent output
- Human score

## Version Pinning

The proof of concept must record and preferably pin:

- Provider versions
- MCP protocol expectations
- Embedding model identifiers
- Provider configuration
- Tree-sitter grammar versions when exposed
- Index schema version when exposed

Provider upgrades may change ranking and evaluation results. Treat them as behavior changes, not ordinary dependency noise.

## Logging and Observability

Record structured events for:

- Provider launch
- Provider ready
- Capability negotiation
- Index request
- Index state change
- Search request
- Search completion
- Fetch request
- Relationship query
- Timeout
- Crash
- Fallback
- Shutdown

Do not log full source chunks by default. Log references, sizes, timing, and result counts.

## Open Questions

The implementing agent should resolve these against the actual provider versions:

- Exact MCP launch commands
- Supported MCP transports
- Whether capability discovery is explicit or must be inferred
- Index registration semantics
- Multi-repository workspace semantics
- Incremental indexing behavior
- How each provider reports staleness
- Whether indexes distinguish revisions or only current files
- How result references expire
- Whether provider scores are stable enough to expose
- Available symbol and graph operations
- Embedding model download and storage behavior
- Offline guarantees after installation
- macOS and Linux support
- Resource usage on Apple Silicon
- Licensing compatibility
- Whether either project is sufficiently stable for optional production use

Document verified answers. Do not rely on assumptions from project descriptions.

## Agent Handoff

An agent implementing this design should:

1. Inspect the current Atlr architecture and command conventions.
2. Locate existing process-management, MCP, configuration, logging, and workspace abstractions.
3. Avoid introducing duplicate infrastructure.
4. Verify current `codesearch` and Octocode documentation and versions.
5. Build the common provider contract before either concrete adapter.
6. Add a mock provider and contract tests.
7. Integrate `codesearch` first.
8. Exercise it on a real Atlr development workspace.
9. Integrate Octocode through the same contract.
10. Add optional graph capabilities without widening the minimum interface unnecessarily.
11. Build the comparative evaluation harness.
12. Record concrete limitations and avoid speculative native implementation.
13. Update architecture, decisions, feature, workflow, and command documentation where required.
14. Keep all user-modifiable artifacts labeled **Manual Edited**, never **Human Edited**.
15. Keep slash-command names aligned with CLI command names and omit redundant `atlr-` prefixes.

## Deliverables

The proof of concept should produce:

- Repository-intelligence domain module
- Provider registry
- MCP transport integration
- Mock provider
- `codesearch` adapter
- Octocode adapter
- Configuration schema
- CLI diagnostics and search commands
- Capability documentation
- Contract tests
- Integration tests
- Evaluation task set
- Comparative evaluation report
- Decision record recommending the next stage

## Final Principle

Atlr should own the repository-intelligence contract, provenance, workflow integration, and project knowledge model.

It should not initially own the general-purpose code indexing engine.

The proof of concept exists to determine which external provider capabilities are valuable, where their boundaries fail, and what Atlr must uniquely add.
