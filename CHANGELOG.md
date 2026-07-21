# Changelog

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
