# Atelier Architecture

## Product boundary

Atelier is an Agentic Development Environment. The CLI is `atlr`.

Atelier owns development state and orchestration. Specialized external tools own editing, navigation, version control, task storage, and general-purpose code intelligence.

## Core flow

```text
Reviewed Plan + Beads + Jujutsu + Ledger + Validation + Code Providers
                              |
                              v
                        Working State
                              |
                              v
                          Model Input
```

## Code Intelligence

Atelier does not own a native parser, source index, embedding pipeline, vector database, ranker, or code graph by default.

```text
CodeService
  ├── CodeProviderRegistry
  ├── CodeProvider contract
  ├── capability model
  ├── normalized references/results
  ├── provenance and staleness
  ├── MCP stdio lifecycle
  └── Working State projection
       ├── codesearch [planned default PoC]
       ├── Octocode [planned experimental provider]
       ├── mock [tests]
       └── disabled [safe fallback]
```

The public CLI namespace is `atlr code`. Internal architecture may use the precise term Repository Intelligence Service or CodeService.

## Repository model

Jujutsu is the primary local repository model. Git is a compatibility and publication boundary.

Snapshots include repository ID, workspace ID, working-copy commit, change ID, operation ID, dirty generation, and dirty fingerprint when Jujutsu is active.

## Task model

Beads is the default replaceable task provider. The reviewed plan remains the Manual Edited scope baseline; the task graph is its executable projection.

## Working State

Working State is deterministic reconstruction from durable sources. Code-provider evidence is a bounded projection containing provider, repository, path, symbol, line, preview, and index state. Full source is fetched only when selected.
