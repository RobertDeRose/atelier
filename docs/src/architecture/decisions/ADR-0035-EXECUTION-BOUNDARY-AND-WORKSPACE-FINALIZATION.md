# ADR-0035: User-Owned Executables, Fail-Closed Shell Fallback, and Workspace Finalization

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

ADR-0032 removed persisted Atelier trust and made workspace containment plus recoverability the filesystem authority. Three implementation gaps remained:

1. repository `.atelier/config.json` could override provider and editor executable paths, so opening a repository could execute repository-selected code before any concrete operation approval;
2. Pi effect extraction and the core shell classifier could disagree, allowing a command classified as a read by one layer to bypass workflow mutation constraints; and
3. multi-repository approval and freshness were exact, but validation freshness, local commits, final-diff review, metadata finalization, and closure were still centered on the primary repository.

The shell executor also permitted an unsandboxed fallback whenever Seatbelt or Bubblewrap was unavailable, while the UI continued to describe the tool as workspace-sandboxed.

## Decision

### Executable configuration is user-owned

Repository configuration may select enumerated provider types and declarative behavior, but it may not set:

- `editor`;
- `beadsCommand`;
- `jjCommand`;
- `codeCommand`; or
- `octocodeCommand`.

Those values come only from user configuration, controlled defaults, or `ATLR_EDITOR`. Atelier rejects repository configuration containing an executable override before provider construction or editor resolution.

### Shell authorization uses one fail-closed result

Pi shell effects remain useful for concrete path and consequence presentation, but a shell operation is considered a repository read only when both:

- the hardened core classifier reports a routine, non-mutating `read.repository`; and
- every Pi effect is a read.

Any disagreement adds an execution, network, or destructive-unknown effect. The adversarial corpus is exercised through the complete Pi effect, workflow, workspace-policy, and executor-selection path.

### Unsandboxed fallback requires exact approval

Seatbelt or Bubblewrap remains automatic when available. When no configured sandbox backend is available:

- every model Bash and direct `user_bash` command requires a concrete one-operation approval;
- the approval explicitly states that the command will run without OS-level confinement;
- the executor receives `allowUnsandboxed: true` only for that approved call; and
- the Bash tool is described as policy-controlled rather than sandboxed.

Typed tools remain the preferred automatic path.

### Finalization is workspace-wide

A `WorkspaceRepositoryService` owns repository-qualified source observation and finalization for the active reviewed task. It:

- resolves the primary and every configured secondary repository;
- enforces the approved path owner for each source change;
- creates scoped local commits in every changed repository;
- produces one combined, repository-labelled final diff and digest;
- computes workspace-wide source-content validation freshness;
- checks local-change and clean-source closure across repositories;
- commits workflow metadata per repository; and
- records partial commit failure with the completed repository set for manual recovery.

Repository-qualified paths use `repositoryId::relative/path`; primary paths retain their existing unqualified representation for compatibility.

## Consequences

- A cloned repository cannot replace Atelier's provider or editor executable through `.atelier/config.json`.
- Repository-provided validation definitions remain executable workflow input, but run only through the reviewed validation path, with a minimal environment and explicit closure contract.
- A permissive secondary shell parser cannot silently weaken the authoritative classifier.
- Lack of an OS sandbox is informed consent, not implied confinement.
- Validation and closure evidence now becomes stale when source content changes in any workspace repository, while metadata-only commits do not stale source-qualified evidence.
- Multi-repository commits are sequential. If a later repository fails, Atelier records partial completion and stops; automatic cross-repository rollback is intentionally not claimed.
