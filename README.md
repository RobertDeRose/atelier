# Atelier

Atelier is an Agentic Development Environment (ADE): a local-first software workshop that combines guarded agent workflows, manually reviewed plans, durable Beads task state, Jujutsu-first repository identity, evidence-backed validation, and replaceable external code-intelligence providers.

The project is **Atelier**. The CLI is **`atlr`**. ADE is the product category.

## v0.8.8 scope

This release improves focused implementation and test retrieval after the v0.8.7 ranking
policy raised codesearch mean weighted recall to 0.5625. Codesearch remains the indexing and
retrieval provider. Atelier now fuses bounded semantic candidates with a small deterministic
set of literal provider queries before applying path focus and the final result budget.

Atelier now owns:

- the provider-neutral Code contract;
- multi-repository workspace identity;
- provider discovery and capability negotiation;
- normalized search results and source references;
- retrieval provenance and index-state reporting;
- MCP stdio process lifecycle;
- Working State integration;
- policy, task, plan, repository, and validation state.

External providers own general-purpose code indexing, parsing, embeddings, ranking, and graphs. Native FTS5 and Tree-sitter code indexes from v0.4.0 were removed.

Atelier now includes a verified `codesearch` adapter based on the documented `codesearch mcp`, bare `codesearch index <path>` repair command, serve registration through `codesearch index add`, and `search`, `find`, `get_chunk`, and `status` MCP operations. Octocode remains a later experimental provider after codesearch semantic health and multi-repository behavior are fully evaluated.

## Requirements

- mise for the development toolchain
- Node.js 24.18.0 (installed and pinned by mise)
- Aube 1.29.1 (installed by mise)
- Git for compatibility mode
- Jujutsu (`jj`) for the primary repository model
- Beads (`bd`) for persistent task state, unless disabled
- A configured editor
- `codesearch` 1.1.x for the default Code provider, or `codeProvider: "disabled"`

## Install and verify

```bash
mise install
mise run install
mise run check
```

`mise install` provisions the versions pinned in `mise.toml` and `mise.lock`: Node, Aube, Jujutsu, jjui, and codesearch. `mise run install` performs a frozen Aube install from the committed `package-lock.json`. Use `aubr <script>` for direct package-script execution.

Run the CLI directly:

```bash
node ./bin/atlr.mjs help
```

## Initial setup

```bash
atlr init
atlr doctor
atlr repo status
atlr status
```

Atelier stores repository-local state under `.atelier/`.

## Core workflow

```bash
atlr plan "implement the requested feature"
atlr review
atlr approve
atlr plan reconcile --apply
atlr ready
atlr state
atlr validate plan
atlr validate focused
```

The reviewed Markdown plan is the Manual Edited scope baseline. Beads is its executable task projection. Jujutsu is the primary local repository model.

## Code provider commands

The user-facing namespace is `code` because an Atelier workspace may contain one repository, a monorepo, or several coordinated repositories.

```bash
atlr code providers
atlr code status
atlr code doctor
atlr code index
atlr code search "where is device authentication handled?"
atlr code search --mode lexical CodesearchProvider
atlr code search --mode semantic "where is authentication handled?"
atlr code search --focus source "where is provider selection implemented?"
atlr code search --focus tests "which tests verify normalization?"
atlr code symbols AuthSession
```

Provider and repository filters are available where supported:

```bash
atlr code search --provider codesearch --repo api,auth "token refresh"
```

Search mode may be `auto`, `semantic`, `hybrid`, or `lexical`. Search focus may be `auto`, `source`, `tests`, `docs`, or `all`. Automatic focus recognizes implementation-, test-, and documentation-oriented questions. Focused source and test searches overfetch compact semantic metadata, issue at most four bounded literal provider queries, fuse evidence by repository path, preserve `providerRank`, record `retrievalMethods`, diversify files, and apply the user-visible retrieval limit afterward. If codesearch reports an operational failure from its semantic/vector path, Atelier performs a bounded literal fallback, marks every result as degraded, and preserves the original provider error in provenance. Explicit `--mode semantic` never hides that failure.

Unsupported provider capabilities must be reported explicitly. Atelier does not silently discard filters or hide fallback-provider semantics.

## Pi commands

Pi commands omit the redundant `atlr-` prefix. Workflow commands remain short:

```text
/status
/plan
/review
/approve
/ready
/state
/changed
/validate
/evidence
```

Code commands use the `code-` namespace because Pi slash commands cannot express a two-level CLI command naturally:

```text
/code-status
/code-index
/code-search <query>
/code-symbols <query>
```

Each command has a command-palette description.

Load the extension during development:

```bash
pi -e ./apps/pi-extension/src/index.ts
```

## Code architecture

```text
Atelier workflow or agent
        |
        v
CodeService
        |
        +-- CodeProviderRegistry
        +-- capability negotiation
        +-- normalized results
        +-- provenance and staleness
        +-- Working State projection
        |
        +-- codesearch adapter      [implemented]
        +-- Octocode adapter        [next experiment]
        +-- mock provider           [implemented]
        +-- disabled provider       [implemented]
```

The common interface supports:

- repository and multi-repository indexing;
- incremental and revision-aware index capabilities;
- lexical, semantic, and hybrid search;
- symbol search, definitions, and references;
- import, call, dependency, and general relationships;
- fetch-on-demand and reranking.

Providers advertise capabilities as data. Atelier does not spread provider-name checks through workflow code.

## MCP foundation

`McpStdioClient` provides a managed JSON-RPC stdio boundary with:

- direct argument-array process launch;
- no shell interpolation;
- request timeouts;
- process-exit detection;
- stderr capture limits;
- graceful termination;
- pending-request failure propagation.

The codesearch adapter performs MCP initialization, tool discovery, capability mapping, result normalization, index-state interpretation, fetch-on-demand, and direct argument-array indexing. Local indexing first closes and waits for the self-contained MCP process, then runs the real repair/update command and verifies that the vector store reports `Indexed: Yes` before reconnecting and accepting MCP `ready`. This avoids competing Tantivy writers. Serve-backed client mode retains `index add` registration because the service owns indexing and lock coordination. Query operations still poll the provider with a configurable timeout.

The repository-local `.codesearchignore` defines the searchable corpus. Atelier fingerprints it together with `.gitignore`, `.osgrepignore`, and the provider version. A changed fingerprint triggers one force rebuild; unchanged inputs retain incremental indexing. Generated real-provider fixtures are therefore available to tests without becoming search evidence.

## Multi-repository workspace model

A `CodeWorkspace` contains:

- a stable workspace ID and name;
- one or more roots;
- one or more repository identities;
- a Jujutsu- or Git-qualified snapshot for each repository.

Search results retain both workspace and repository identity so Working State can explain where evidence came from.

## Provenance

Every normalized result can record:

- provider name, version, and instance;
- workspace and repository;
- requested and actual search modes;
- query and retrieval time;
- index state;
- requested and enforced filters;
- adapter-side post-processing;
- reranking status;
- a fetchable provider reference.

Provider output is evidence, not authority. Critical results should still be verified against current source.

## Manual Edited terminology

Atelier uses **Manual Edited** for artifacts modified directly through an editor or another user-controlled tool. It never uses "Human Edited" as a provenance category.

## Validation

```bash
atlr validate list
atlr validate plan
atlr validate focused
atlr validate run check
atlr evidence
```

Validation evidence remains qualified by repository snapshot and becomes stale after relevant working-copy changes.

## Current limitations

- No Octocode adapter yet.
- Focused retrieval still requires one live benchmark run before Atelier decides whether codesearch alone is sufficient or an Octocode comparison should begin.
- No persistent daemon or JSON-RPC service boundary.
- The codesearch adapter supports imports, dependents, and usage relationships; deeper provider-specific graph evaluation remains pending.
- Jujutsu live conformance still requires a real supported `jj` binary.

Configure the provider in `.atelier/config.json`:

```json
{
  "codeProvider": "codesearch",
  "codeCommand": "codesearch",
  "codeMode": "auto",
  "codeTimeoutMs": 60000,
  "codeIndexTimeoutMs": 300000
}
```

`auto` uses `codesearch mcp`; `local` forces the local repository index; `client` requires a running multi-repository `codesearch serve` instance. See `docs/CODE_INTELLIGENCE.md` and `docs/IMPLEMENTATION_PLAN.md` for the next stages.

## Multi-repository code workspace

Define `.atelier/workspace.json` when a task spans multiple repositories:

```json
{
  "name": "product",
  "repositories": [
    { "id": "api", "path": "../api", "role": "backend", "codesearchProject": "api" },
    { "id": "ui", "path": "../ui", "role": "frontend", "codesearchProject": "ui" }
  ]
}
```

Validate it with `atlr config validate`. Code retrieval is bounded by provider-neutral limits in `.atelier/config.json`: `codeMaxResults`, `codeMaxPreviewBytes`, `codeMaxChunkBytes`, `codeMaxFetches`, and `codeMaxTotalBytes`.

## Real codesearch probe

On a machine with codesearch installed, run:

```bash
mise run test:codesearch:live
```

The live task is intentionally separate from `mise run check`; ordinary tests inject disabled, mock, or process-compatible fake providers and never start codesearch. The probe writes a self-contained report under `.atelier/codesearch-probe`, records vector statistics before and after repair, requires the HNSW index to be built, waits for the raw MCP index to become ready, captures complete tool schemas and raw provider responses, separately exercises semantic, hybrid, literal, and automatic search, captures codesearch doctor/statistics and index-store metadata, and exercises symbols, fetch, outline, impact, edit, and reindex behavior, and produces `CONFORMANCE.md` plus `conformance.json`.


## Codesearch conformance and evaluation

Use `mise run collect:codesearch` on a development machine to gather the complete live-provider contract, optional tools, fetch behavior, reindex behavior, and comparative evaluation. The collector now always normalizes available fixtures and creates `atelier-codesearch-knowledge.tar.xz`, even when conformance reports failures; it then exits with the retained conformance status. `mise run fixtures:codesearch` normalizes a prior probe independently and fails clearly when the probe is empty. See `docs/CODESEARCH_EVALUATION.md` and the first live report in `docs/CODESEARCH_EVALUATION_REPORT_2026-07-21.md`.
