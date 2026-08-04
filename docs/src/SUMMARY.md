# Summary

## Introduction

- [Project overview](introduction/project-overview.md)
- [Documentation conventions](introduction/documentation-conventions.md)

## Architecture

- [Architecture overview](architecture/index.md)
- [Architecture decisions](architecture/decisions/index.md)
  - [ADR-0001: Use Jujutsu as the Primary Repository Model](architecture/decisions/ADR-0001-JUJUTSU-FIRST.md)
  - [ADR-0002: Integrate Code Intelligence Before Building It](architecture/decisions/ADR-0002-EXTERNAL-CODE-PROVIDERS.md)
  - [ADR-0003: Use codesearch as the Default Code Provider](architecture/decisions/ADR-0003-CODESEARCH-DEFAULT.md)
  - [ADR-0004: Preserve Code Retrieval During Semantic Provider Failure](architecture/decisions/ADR-0004-DEGRADED-CODESEARCH-FALLBACK.md)
  - [ADR-0005: Verify Codesearch Vector Index Readiness](architecture/decisions/ADR-0005-VERIFY-CODESEARCH-VECTOR-INDEX.md)
  - [ADR-0006: Release MCP Before Local Codesearch Indexing](architecture/decisions/ADR-0006-RELEASE-MCP-BEFORE-LOCAL-INDEX.md)
  - [ADR-0007: Exclude Captured Provider Evidence from Code Retrieval](architecture/decisions/ADR-0007-CODESEARCH-CORPUS-SELECTION.md)
  - [ADR-0008: Apply Workflow Focus After Provider Retrieval](architecture/decisions/ADR-0008-FOCUSED-CODE-RETRIEVAL.md)
  - [ADR-0009: Fuse Semantic and Literal Evidence for Focused Retrieval](architecture/decisions/ADR-0009-SEMANTIC-LITERAL-RETRIEVAL-FUSION.md)
  - [ADR-0010: Exact Identifier Retrieval Hints](architecture/decisions/ADR-0010-EXACT-IDENTIFIER-RETRIEVAL-HINTS.md)
  - [ADR-0011: Accept codesearch as the default Code provider](architecture/decisions/ADR-0011-CODESEARCH-POC-ACCEPTED.md)
  - [ADR-0012: Capability-gate Octocode against its live MCP contract](architecture/decisions/ADR-0012-OCTOCODE-LIVE-CONTRACT.md)
  - [ADR-0013: Build Repository Evidence from Durable Workflow State](architecture/decisions/ADR-0013-TASK-BACKED-WORKING-STATE-RETRIEVAL.md)
  - [ADR-0014: Resolve SQLite dynamically for Pi extension compatibility](architecture/decisions/ADR-0014-PI-SQLITE-RUNTIME-COMPATIBILITY.md)
  - [ADR-0015: Support Node and Bun SQLite runtimes at the ledger boundary](architecture/decisions/ADR-0015-DUAL-RUNTIME-SQLITE.md)
  - [ADR-0016: Normalize SQLite missing rows at the runtime boundary](architecture/decisions/ADR-0016-SQLITE-MISSING-ROW-CONTRACT.md)
  - [ADR-0017: Plan reads and provider-first code tools](architecture/decisions/ADR-0017-PLAN-READS-AND-PROVIDER-FIRST-TOOLS.md)
  - [ADR-0018: Default approved repository execution](architecture/decisions/ADR-0018-APPROVED-REPOSITORY-EXECUTION.md)
  - [ADR-0019: Exact Reviewed-Plan Approval and Task-Scoped Execution](architecture/decisions/ADR-0019-EXACT-PLAN-EXECUTION.md)
  - [ADR-0020: Verify Octocode embedding prerequisites and searchable blocks](architecture/decisions/ADR-0020-OCTOCODE-EMBEDDING-PREFLIGHT.md)
  - [ADR-0021: Reject Octocode for default repository retrieval](architecture/decisions/ADR-0021-OCTOCODE-DEFAULT-RETRIEVAL-REJECTED.md)
  - [ADR-0022: Coordinate background code indexing](architecture/decisions/ADR-0022-BACKGROUND-CODE-INDEX-COORDINATOR.md)
  - [ADR-0023: Explicitly activate Atelier code tools in Pi](architecture/decisions/ADR-0023-PI-ACTIVE-CODE-TOOLS.md)
  - [ADR-0024: Trust projects before loading executable configuration](architecture/decisions/ADR-0024-PROJECT-TRUST-AND-RUNTIME-STATE.md)
  - [ADR-0025: Approve typed task constraints and treat shell as unconfined](architecture/decisions/ADR-0025-TYPED-TASK-CAPABILITIES-AND-UNCONFINED-SHELL.md)
  - [ADR-0026: Use one authoritative task-completion predicate](architecture/decisions/ADR-0026-AUTHORITATIVE-TASK-COMPLETION.md)
  - [ADR-0027: Bind exact approval to every workspace repository and retrieval revision](architecture/decisions/ADR-0027-WORKSPACE-REVISION-BINDINGS.md)
  - [ADR-0028: Preserve user control while tasks remain incomplete](architecture/decisions/ADR-0028-USER-CONTROL-AND-TYPED-VALIDATION.md)
  - [ADR-0029: Derive exact capabilities and source evidence from structured task scope](architecture/decisions/ADR-0029-EXACT-TASK-SCOPE-AND-SOURCE-ISOLATION.md)
  - [ADR-0030: Repository finalization and closure semantics](architecture/decisions/ADR-0030-REPOSITORY-FINALIZATION-AND-CLOSURE-SEMANTICS.md)
  - [ADR-0031: TUI approval, status, and VCS identity](architecture/decisions/ADR-0031-TUI-APPROVAL-STATUS-AND-VCS-IDENTITY.md)
  - [ADR-0032: Session workspace recoverability policy](architecture/decisions/ADR-0032-WORKSPACE-RECOVERABILITY-POLICY.md)
  - [ADR-0033: Persistent Markdown Reports for Atelier Commands](architecture/decisions/ADR-0033-PERSISTENT-MARKDOWN-REPORTS.md)
  - [ADR-0034: Expandable Report Cards and Workflow Command Naming](architecture/decisions/ADR-0034-EXPANDABLE-REPORT-CARDS.md)
  - [ADR-0035: User-Owned Executables, Fail-Closed Shell Fallback, and Workspace Finalization](architecture/decisions/ADR-0035-EXECUTION-BOUNDARY-AND-WORKSPACE-FINALIZATION.md)
  - [ADR-0036: Interactive observation pipeline](architecture/decisions/ADR-0036-INTERACTIVE-OBSERVATION-PIPELINE.md)
  - [ADR-0037: Canonical Path Identity and Filesystem Entry Semantics](architecture/decisions/ADR-0037-CANONICAL-PATH-IDENTITY.md)
  - [ADR-0038: Direct User Bash Denial Uses Pi's Replacement-Result Contract](architecture/decisions/ADR-0038-DIRECT-USER-BASH-DENIAL-CONTRACT.md)
  - [ADR-0039: Pi UI Lifecycle and Durable Presentation Evidence](architecture/decisions/ADR-0039-PI-UI-LIFECYCLE-AND-EVIDENCE.md)
  - [ADR-0040: Keep Mutable Provider State Outside the Working Copy](architecture/decisions/ADR-0040-EXTERNAL-PROVIDER-STATE-AND-TRANSIENT-SNAPSHOT-RETRY.md)
  - [ADR-0041: Present Transient Work Inline and Format Plan Authority for Review](architecture/decisions/ADR-0041-INLINE-PHASES-AND-READABLE-PLAN-AUTHORITY.md)
  - [ADR-0042: Separate Transient Progress from Durable Status and Gate Plan Retrieval on Review](architecture/decisions/ADR-0042-TRANSIENT-PROGRESS-AND-REVIEWED-PLAN-RETRIEVAL.md)
  - [ADR-0043: Make Phase Surfaces Lifecycle-Explicit and Verify UI Evidence Chronologically](architecture/decisions/ADR-0043-LIFECYCLE-EXPLICIT-PHASE-SURFACES-AND-CHRONOLOGICAL-EVIDENCE.md)
- [Architecture history](architecture/history/index.md)
  - [Review corrections](architecture/history/review-corrections.md)

## Operator's Manual

- [Operator's manual](operations/index.md)
- [Local acceptance](operations/local-acceptance.md)
- [GitHub Pages deployment](operations/github-pages.md)
- [Operations history](operations/history/index.md)
  - [Manual acceptance corrections](operations/history/manual-acceptance-corrections.md)

## Development Guide

- [Development guide](development/index.md)
- [Developer tooling](development/tooling.md)
- [Feature lifecycle](development/feature-lifecycle.md)
- [Code intelligence](development/code-intelligence/index.md)
  - [Provider contract](development/code-intelligence/provider-contract.md)
  - [Codesearch](development/code-intelligence/codesearch/index.md)
    - [Evaluation and conformance](development/code-intelligence/codesearch/evaluation.md)
    - [Codesearch evidence](development/code-intelligence/codesearch/evidence/index.md)
      - [Evaluation report — 2026-07-21](development/code-intelligence/codesearch/evidence/evaluation-2026-07-21.md)
      - [Index repair report — 2026-07-21](development/code-intelligence/codesearch/evidence/index-repair-2026-07-21.md)
      - [MCP writer-lock report — 2026-07-21](development/code-intelligence/codesearch/evidence/mcp-writer-lock-2026-07-21.md)
      - [Vector-store report — 2026-07-21](development/code-intelligence/codesearch/evidence/vector-store-2026-07-21.md)
      - [Corpus selection report — 2026-07-22](development/code-intelligence/codesearch/evidence/corpus-selection-2026-07-22.md)
      - [Focused retrieval report — 2026-07-22](development/code-intelligence/codesearch/evidence/focused-retrieval-2026-07-22.md)
      - [Retrieval economy report — 2026-07-27](development/code-intelligence/codesearch/evidence/retrieval-economy-2026-07-27.md)
  - [Octocode](development/code-intelligence/octocode/index.md)
    - [Integration](development/code-intelligence/octocode/integration.md)
    - [Evaluation](development/code-intelligence/octocode/evaluation.md)
- [Development evidence](development/evidence/index.md)
  - [UI-latency evidence](development/evidence/ui-latency/index.md)
    - [Alpha.29 audit](development/evidence/ui-latency/audit-alpha29.md)
    - [Alpha.30 corrections](development/evidence/ui-latency/corrections-alpha30.md)
- [Development history](development/history/index.md)
  - [Historical implementation plan](development/history/implementation-plan.md)
  - [Historical alpha.9 roadmap](development/history/roadmap-alpha9.md)
  - [Historical alpha.10 roadmap delivery](development/history/roadmap-implementation-alpha10.md)

## Roadmap

- [Planned features](planned-features.md)
  <!-- BEGIN FEATURE DESIGNS -->
  <!-- END FEATURE DESIGNS -->
- [Implemented features](features/index.md)
  <!-- BEGIN IMPLEMENTED FEATURES -->
  <!-- END IMPLEMENTED FEATURES -->

## Reference

- [Reference](reference/index.md)
- [Plan format](reference/plan-format.md)
- [Tooling reference](reference/tooling.md)
