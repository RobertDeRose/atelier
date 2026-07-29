# Atelier Architecture — 0.14.0-alpha.6

## Product boundary

Atelier is a local-first workflow control plane for an Agentic Development Environment. The CLI is
`atlr`; Pi is the current interactive host. Atelier owns project trust, reviewed-plan execution,
authorization, task reconciliation, durable evidence, validation closure, Working State, and normalized
code-provider orchestration.

External tools retain their native ownership:

- editors own interactive text editing;
- Jujutsu is the primary repository model and Git is the compatibility provider;
- Beads or another `TaskProvider` owns task storage;
- codesearch and Octocode own indexing and retrieval implementation;
- configured commands own validation behavior;
- the operating system owns process isolation. Atelier does not currently provide a shell sandbox.

## Runtime topology

```mermaid
flowchart TD
    CLI[atlr CLI] --> Core[AtelierCore]
    Pi[Pi extension / per-session state] --> Core
    Core --> Trust[External Project Trust]
    Core --> Policy[Policy Engine]
    Core --> Exec[Execution Workflow Coordinator]
    Core --> Review[Plan Review / ManualEdit]
    Core --> Tasks[Plan Reconciler / TaskProvider]
    Core --> Repo[RepositoryProvider]
    Core --> Validation[ValidationService]
    Core --> Code[CodeService / Provider Registry]
    Core --> State[WorkingStateBuilder]
    Core --> Ledger[(External SQLite Ledger)]
```

There is no daemon or transport boundary in this release. Core is an in-process TypeScript runtime used
by the CLI and Pi extension.

## Trust boundary

Trust is decided before repository-owned configuration is loaded. The record is stored in the user state
directory, outside the project.

```mermaid
flowchart LR
    Repo[Repository files] -->|untrusted: ignored for execution| Safe[Non-executing defaults]
    User[External trust record] --> Gate{Trusted?}
    Gate -->|No| Safe
    Gate -->|Yes| Config[Load project config]
    Config --> Providers[Start VCS / tasks / validation / editor / code providers]
```

Before trust:

- repository `config.json` does not override executable commands;
- validation, editor, task, VCS, and code-provider commands do not start;
- Pi does not start background indexing;
- `doctor` remains observational and does not open SQLite;
- runtime state remains outside the repository and is not redirected by project configuration.

Additional multi-repository roots require separate external approval.

See ADR-0024.

## Project data and runtime data

Trackable project documents:

```text
.atelier/config.json
.atelier/PLAN.md
.atelier/validation.json
.atelier/workspace.json
```

User-owned runtime state:

```text
${ATLR_STATE_HOME:-${XDG_STATE_HOME:-~/.local/state}}/
  atelier/repositories/<canonical-root-hash>/atelier.db
```

The runtime database contains approvals, execution and permission grants, task mappings, tool evidence,
validation evidence, retrieval evidence, workflow checkpoints, and Working State inputs.

## Exact approval transaction

Preparation records:

- exact reviewed plan hash;
- task-provider identity and version;
- deterministic reconciliation digest and operation set;
- primary repository snapshot;
- revision bindings for every approved workspace root;
- retrieval provider/index revision bindings;
- exact typed capability bundle and digest.

Approval reparses and recomputes all of those values immediately before mutation. Rejection performs no
provider mutation. Acceptance applies reconciliation, verifies convergence, claims one approved-plan
task, then atomically stores:

- accepted plan approval;
- applied reconciliation transaction;
- active execution grant;
- typed task-capability grants;
- workflow mode and current task state.

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Reviewed: ManualEdit complete
    Reviewed --> Prepared: exact preview
    Prepared --> Rejected: user rejects
    Prepared --> Invalidated: any binding drifts
    Prepared --> Applying: user approves
    Applying --> Active: reconcile + claim + atomic activation
    Applying --> Failed: mutation/convergence/claim failure
    Active --> Paused: explicit pause
    Paused --> Active: explicit resume
    Active --> Cancelled: cancel + atomic workflow transition
    Paused --> Cancelled: cancel + atomic workflow transition
    Active --> Completed: authoritative close
    Active --> Invalidated: resume binding failure
```

Legacy execution records without the structured task contract and matching exact capability bundle fail
closed. See ADR-0019, ADR-0025, ADR-0028, and ADR-0029.

## Authorization

The permission boundary is effect- and execution-aware:

```text
typed       Atelier knows the operation and resolves/checks its paths
sandboxed   reserved for a future verifiable process sandbox
unconfined  generic shell or process execution
```

Every approvable task carries a machine-readable execution contract in its `atlr:task` metadata. Exact
plan approval derives only path-scoped non-dependency writes, explicitly reviewed dependency manifests,
named focused/full validations, optional reviewed-path local-change creation, and task closure. Task
update/link, dependency, full-suite, and generic-shell authority are not implicit. Preparation rejects a
missing or inconsistent contract, and the approval surface displays the full capability projection.

Typed file operations must remain inside the approved root after real-path resolution, including
nearest-existing-ancestor checks for new files. Validation names, commit paths, task identity, repository
identity, and execution identity must all match the active reviewed contract.

Generic shell is always unconfined in this release. It does not inherit typed task capabilities and
requires a one-operation grant. The shell classifier provides effect/risk information, not a security
proof of repository confinement.

Supported grant lifecycles are `operation`, `task`, and `repository`. Operation grants are consumed at
authorization attempt. Task grants are bound to an active execution. Legacy `turn` and `session` grants
are revoked by migration.

## Repository authority and source baselines

Each repository provider returns explicit status and a revision-aware snapshot. Failures throw
`RepositoryObservationError`; they never become an empty change list.

Git and Jujutsu snapshots carry two related identities. Raw VCS fields retain commit/change/operation
details for diagnostics and recovery. A separate source base plus source-content fingerprint excludes
`.atelier`, Beads, provider indexes, and other workflow metadata. Approval, retrieval, validation, and
execution freshness use the source identity rather than raw metadata churn.

Exact approval binds every workspace root independently. Primary source drift can represent the approved
task’s own work when the baseline remains reachable. Secondary-root drift invalidates execution because
Atelier cannot attribute it to the active primary task. See ADR-0027.

## Tool execution evidence

Pi performs blocking authorization before a mutating typed tool. Atelier stores:

- policy decision and matched grant;
- active task/execution identity;
- before repository snapshot;
- started, succeeded, failed, or interrupted outcome;
- after snapshot and the path/content delta attributable to that operation, separate from paths already
  dirty before it started;
- bounded error details.

One-operation grants are consumed at authorization, not after success. Pending evidence is marked
interrupted during shutdown/recovery. Runtime interruption is derived from structured abort state or an
exact tool-owned abort sentinel; arbitrary error text cannot turn a normal failure into interruption.

## Validation and completion

Validation commands execute as argument arrays with `shell: false`, bounded and redacted output,
abort-aware process-group termination, a sanitized environment, and repository/environment fingerprints.
Pi exposes the same boundary to the model through typed `atlr_validate`; declared checks never require a
Bash substitution.

Task completion uses one authoritative predicate:

```mermaid
flowchart TD
    V[Required validations current and passing] --> Ready{All true?}
    D[Exact current baseline diff reviewed] --> Ready
    C[Local commit / finalized change exists] --> Ready
    R[Configured repository cleanliness holds] --> Ready
    Ready -->|Yes| Close[Allow task close]
    Ready -->|No| Block[Block and explain missing/stale/failed evidence]
```

If validation is required, at least one applicable check must be `required: true`. Readiness separately
reports a missing focused selection, a no-match selection, or missing required configuration. The removed
validation `approval` field is rejected. Final-diff review is hash-bound; a changed diff must be previewed
and reviewed again.

The predicate blocks task closure, not user control. An incomplete task may remain active and idle.
`agent_settled` emits at most one passive notice and never schedules a follow-up model turn.
`/atelier-stop` ends only the current turn; `/atelier-pause` durably disables agent mutation;
`/atelier-resume` restores the active execution; `/cancel` atomically revokes the grant and workflow
without waiting for idle. See ADR-0026, ADR-0028, and ADR-0029.

## Working State

Working State is deterministic reconstruction from durable sources:

- trust and workflow mode;
- reviewed plan and exact approval;
- reconciliation and active execution;
- current task, approved-plan ready tasks, dependencies, and blockers;
- active capabilities and one-operation grants;
- mutation and validation evidence;
- repository snapshots and closure readiness;
- bounded code evidence with provenance and freshness;
- corrections, findings, decisions, omissions, and next action.

Conversation text and model compaction are not authorities. Pi receives reconstructed Working State at
agent start and before compaction. Compaction still exists in this release, but its summary is seeded from
durable state rather than treated as the source of truth.

## Code intelligence

Atelier owns provider contracts, capability negotiation, budgets, normalized references, provenance,
revision bindings, deduplication, reuse, and invalidation. Providers own indexes.

```text
CodeService
  ├── codesearch (default)
  ├── Octocode (optional)
  ├── mock (tests)
  └── disabled
```

Provider-first retrieval is advisory. Pi activates provider tools and records fallback/degradation, but
retrieval economy does not deny otherwise authorized inspection. Evidence is isolated by provider,
workspace, repository scope, source revision, and index revision.

## Session lifecycle

Each Pi session owns its own Core, root, plan-review state, retrieval session, and index coordinator.
Session replacement and shutdown await asynchronous provider disposal before SQLite closes. This avoids
cross-session state replacement and late MCP callbacks against a closed ledger.

## Build and conformance

Stable JavaScript and declarations are emitted through `tsconfig.build.json`. The package and launcher
consume `dist`; TypeScript source launchers are development-only.

Deterministic CI runs the pinned Node/lockfile gate. Live Jujutsu, codesearch, Beads, and Pi/Bun checks are
separate manually dispatched conformance jobs so fixture evidence cannot be confused with live results.
