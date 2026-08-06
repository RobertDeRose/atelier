# Design — First-class dstack workflow harness

## Metadata

- Beads feature root: `atelier-fon`
- Feature slug: `first-class-dstack-harness`
- Design path: `docs/src/features/first-class-dstack-harness/design.md`
- Implemented record: `docs/src/features/first-class-dstack-harness/index.md`
- Base branch: `main`
- Implementation repository: Atelier (the current project repository)
- Status: draft

## Feature Summary

Make Atelier the execution harness for the dstack workflow instead of a parallel, partial
workflow system. dstack owns the documentation-first workflow contract; Beads owns live task
state; Atelier Core coordinates bounded execution, code intelligence, snapshots, quality gates,
evidence, recovery, and closure; CLI and Pi present the same state.

## User Intent

Atelier should turn the existing dstack workflow into a first-class harness that reduces context
overhead by combining code intelligence, Beads task tracking, and snapshot-based safety. Users
should work through a coherent feature/task lifecycle rather than learn separate Atelier and
dstack abstractions.

The harness must preserve active tasks, grants, files, repository ownership, and scope during
restart, compaction, pause, and recovery. It must never resume mutation automatically, invent
quality-check bypasses, or make a transcript, provider result, UI, or generated report an
authority.

## Goals

- Make plan, start, implement, review, audit, pause, recover, and close first-class Core
  lifecycle operations for dstack features and bounded tasks.
- Use Beads as the live authority for feature/task identity, hierarchy, dependencies, claims,
  blockers, and status.
- Build bounded, reusable context capsules from only relevant Beads, designs, implemented
  records, code-intelligence results, review evidence, snapshots, and quality-gate inventory.
- Make repository/source snapshots and recovery checkpoints lifecycle-native and bind approvals,
  grants, review findings, gate runs, and closure evidence to exact identities.
- Replace user-facing validation selection with repository quality-gate discovery and enforcement,
  including normal Git hooks, signing, filters, and user configuration.
- Expose the same lifecycle through CLI and Pi without moving workflow authority into either
  surface.
- Preserve existing Atelier state and historical evidence through additive migration.

## Non-Goals

- Replacing dstack's documentation-first design, roadmap, or implemented-record authority.
- Replacing Beads, Git/Jujutsu, Pi, editors, code-provider indexes, or OS sandboxing.
- Making conversation history, compaction summaries, provider output, or UI reports durable
  workflow authority.
- Requiring users to understand internal quality-gate providers or validation schema names.
- Automatically resuming mutation after a crash, restart, compaction, pause, or recovery decision.
- Introducing a general-purpose backup system or weakening strict scope, ownership, diff, commit,
  signing, hook, filter, or recovery checks.

## User-Facing Behavior

The supported workflow remains available from both `atlr` and Pi, with one shared Core/Beads
state:

1. Plan or select a dstack feature/task.
2. Review the design, graph, scope, and discovered repository quality gates.
3. Explicitly activate a bounded task.
4. Receive a compact context capsule rather than a full repository/history dump.
5. Implement within the reviewed scope while Core records evidence and snapshot identity.
6. Review, validate through repository quality gates, commit, and close explicitly.
7. Pause, recover, or cancel with preserved task/grant/scope/ownership state; Continue is always
   an explicit user action.

Existing command names remain stable unless a later reviewed migration changes them. CLI and Pi
must show user-language next actions, blockers, freshness, and recovery state without exposing
internal provider names as required knowledge.

## Requirements

### Functional Requirements

- Model dstack feature/task lifecycle transitions in Core and map them to the lifecycle commands
  represented by `/plan-features`, `/start-feature`, `/implement-feature`, `/implement-task`,
  `/close-feature`, and `/audit-project`.
- Preserve canonical Beads issue identity, parentage, dependency direction, claims, blockers,
  review state, and closure reasons.
- Generate a context capsule containing relevant task/feature graph state, exact design and
  implemented pages, bounded retrieval evidence, snapshot identity, review findings, gate
  inventory, and source locations with provenance.
- Reuse an unchanged capsule within its validity boundary and invalidate affected sections when
  source, Beads, provider, index, design, or snapshot identity changes.
- Capture a source/repository/task/scope/ownership baseline before every effectful lifecycle
  transition and bind grants, evidence, review findings, and gate runs to it.
- Discover and run repository quality gates through the quality-gate workstream `atelier-k36`.
  New work must not require users to name an abstract validation.
- Keep CLI and Pi adapters equivalent with respect to authorization, scope, ownership, evidence,
  quality gates, snapshots, recovery, and closure.

### Quality Requirements

- Context assembly is deterministic, bounded by configured item/byte/history/retrieval/output
  budgets, redacted, and explicit about omissions and truncation.
- Provider-first retrieval remains advisory; provider degradation never becomes an authorization
  grant or a reason to perform unbounded discovery.
- Snapshot comparison is deterministic and stale evidence is rejected at the narrowest affected
  boundary.
- Mutation paths fail closed on ambiguous scope, ownership, repository, hook, signing, filter,
  provider, or recovery state.
- Git uses user configuration by default. No path silently uses `--no-verify`, `--no-gpg-sign`,
  an empty hooks path, disabled filters, alternate signing configuration, or an invented bypass.
- Recovery actions are auditable, bounded, and explicit. A closure blocker cannot prevent pause,
  cancel, or Continue decisions for an active task.

### Compatibility and Migration Requirements

- Existing `.atelier` configuration, plans, execution contracts, grants, ledger/evidence rows,
  snapshots, task records, and recovery state remain readable.
- Historical validation records remain distinguishable from current quality-gate evidence and are
  never rewritten as if they were new results.
- Active tasks preserve their identity, grants, scope, files, repository ownership, and intent;
  ambiguous mappings require a user decision rather than inference.
- Migration is additive, idempotent, restartable, bounded, observable, and non-destructive.
- Current CLI/Pi commands and reader-facing docs remain usable during the migration boundary.

## Existing Context

Atelier already owns reviewed-plan execution, task reconciliation, immutable session workspaces,
repository observations, exact recovery checkpoints, durable ledger evidence, Working State,
provider-neutral code intelligence, and CLI/Pi integration. The delivered [Unified CLI and Pi
Workflow](../cli-pi-workflow/index.md), [Exact Plan Execution](../exact-plan-execution/index.md),
[Mutation and Validation Evidence](../mutation-validation-evidence/index.md), and retrieval
features provide the relevant contracts.

The current architecture documents Core as the authority for workflow, evidence, validation,
recovery, and closure while Beads, VCS, editors, and providers retain native responsibilities.
The existing `atelier-fon` graph contains bounded workstreams for lifecycle orchestration, compact
context, snapshots, CLI/Pi adapters, migration, and end-to-end verification. `atelier-k36` is the
quality-gate workstream and contains discovery, Git-policy, failure, planning, evidence,
migration, and verification tasks.

The dstack workflow adds a formal feature lifecycle, slug-scoped designs, implemented records,
Beads-backed task graphs, bounded implementation tasks, shared factual review packets, durable
review findings, documentation reconciliation, and explicit delivery. This feature adopts those
contracts rather than recreating them in Atelier-specific state.

## Proposed Design

### Authority layers

| Concern                      | Authority                                        | Atelier responsibility                                           |
|------------------------------|--------------------------------------------------|------------------------------------------------------------------|
| Feature intent and decisions | `design.md`, explicit user decisions             | Load exact bounded context; never infer missing policy           |
| Roadmap narrative            | `docs/src/planned-features.md`                   | Reconcile delivered status; do not use as live state             |
| Live task graph              | Beads                                            | Query, claim, reconcile, preserve dependencies and evidence      |
| Runtime execution            | Atelier Core and external ledger                 | Enforce scope, grants, snapshots, effects, evidence, and closure |
| Repository state             | Git/Jujutsu provider and user configuration      | Observe exact revisions and commit without policy bypass         |
| Code intelligence            | Configured provider/index                        | Normalize provenance, budgets, freshness, and bounded evidence   |
| Quality gates                | Repository policy through `atelier-k36` adapters | Discover, execute, classify failures, and bind evidence          |
| Presentation                 | CLI and Pi adapters                              | Render state and request explicit user decisions only            |

### Lifecycle orchestration

Core exposes one typed lifecycle coordinator for feature and task operations. It resolves canonical
Beads identities and verifies prerequisites before each transition:

```text
plan -> review -> prepared -> explicitly activated
  -> bounded implementation -> review/audit
  -> current quality-gate evidence -> diff review -> commit -> explicit close

active -> pause | cancel | recovery-required
recovery-required -> explicit Continue | Pause | Cancel
```

The lifecycle coordinator does not duplicate Beads state. It records bindings and evidence in the
external ledger, invalidates stale sections when authoritative inputs change, and delegates task
storage, repository operations, retrieval, and quality-gate execution to typed adapters.

### Context capsules

A context builder assembles one factual packet for the current feature/task or review boundary.
It queries only:

- the selected Beads issue, relevant ancestors, blockers, dependencies, and current review state;
- exact design, implemented, architecture, reference, and reader-facing pages named by the design;
- bounded code-intelligence results with provider, repository, source revision, index revision,
  freshness, and provenance;
- current Working State, approved scope, snapshot identity, recovery state, and gate inventory;
- current open review findings and the source locations needed to verify them.

Each section has an item/byte budget, digest, source boundary, and freshness. The packet is
serialized deterministically, redacted, and reused while all identities remain unchanged. A
review run creates one factual packet and shares it with its role reviewers. Missing or degraded
providers produce bounded omission records and do not authorize broad raw discovery.

### Snapshot and recovery safety

Every effectful transition records a baseline covering the repository/source identity, active task,
reviewed scope, workspace/ownership identity, provider/index identity, and relevant Beads state.
Evidence and grants carry the baseline digest. Drift invalidates only the affected authorization or
evidence and reports the exact recovery action.

Recovery preserves source files, task identity, grants, scope, ownership, and task intent. No
startup or restart path begins mutation automatically. Pi's native recovery selection and CLI
recovery commands remain presentation adapters over this Core contract.

### Quality-gate integration

The existing `atelier-k36` workstream defines the repository quality-gate profile, discovery
precedence, adapters, Git-policy enforcement, bounded failure handling, planning inventory,
commit/closure evidence, compatibility migration, and end-to-end verification. The harness uses
its typed results without making quality-gate names part of task scope or user intent.

Gate evidence binds the exact source/staged snapshot, gate configuration and tool identity,
command, changed-path coverage, bounded output, exit/cancellation status, and mutation detection.
Hook, signing, or filter failures retain their real cause. Safe remediation is bounded; retry,
pause, cancel, or a one-turn explicit bypass are user decisions and are auditable.

### CLI and Pi adapters

CLI and Pi call the same Core coordinator and render the same next-action model. They may differ in
interaction style, but neither may claim tasks directly, widen scope, approve stale plans, bypass
repository policy, or close without current evidence. Status and recovery views use compact
context-capsule fields rather than full transcript or repository dumps.

## Architecture Consistency

### Existing Patterns Reused

- `AtelierCore`, `ExecutionWorkflowCoordinator`, `WorkflowGuard`, and task-provider contracts for
  lifecycle decisions.
- `WorkingStateBuilder` and external ledger records for deterministic reconstruction.
- Repository snapshots, source identity, `ExecutionBaseline`, and `RecoveryManager` for safety.
- `CodeService`, provider registry, retrieval sessions, provenance, and existing budgets for code
  intelligence.
- Existing CLI/Pi command registration, status reports, typed tools, and native recovery UI.
- Beads parent/child and blocker dependencies instead of a second task database.

### Invariants Preserved

- Core remains authoritative for execution, permissions, scope, repository evidence, quality-gate
  enforcement, recovery, and closure.
- Beads remains authoritative for live task state and dependency relationships.
- Conversation history, compaction, provider output, and reports remain observations.
- All mutating operations are bounded, cancellable, redacted, recoverable, and fail closed.
- Git/Jujutsu user policy, hooks, signing, filters, and configured credentials are not silently
  weakened.
- User control remains explicit after approval, failure, pause, restart, or recovery.

### New Decisions Introduced

- The dstack lifecycle is a Core-owned orchestration boundary, not only a collection of agent
  skills or documentation procedures.
- Feature root `atelier-fon` adopts the dstack lifecycle metadata and one implementation
  coordinator; existing bounded workstreams are reconciled beneath that lifecycle.
- `atelier-k36` remains the quality-gate workstream and is reconciled as implementation-owned
  work rather than a competing top-level feature.
- Context capsules are bounded evidence packets with stable identity, not a new authority or
  persistent copy of the repository/task graph.

### Architecture Documentation Changes

Update `docs/src/architecture/overview.md` to describe the dstack lifecycle coordinator, authority
layers, context-capsule boundary, and quality-gate integration. Keep existing provider, snapshot,
recovery, and CLI/Pi ownership statements intact.

## Operational Considerations

Users can switch between CLI and Pi after the previous client is idle by refreshing status. Context
capsules and snapshots remain external/runtime-owned where mutable; durable design, roadmap,
implemented records, and Beads state remain inspectable project/workflow artifacts.

Operators should inspect status, snapshot freshness, gate state, and next action rather than infer
state from transcript history. Provider/index degradation, gate failures, stale evidence, and
recovery-required states must report exact bounded remediation. Runtime and provider caches remain
outside repositories.

## Documentation Impact

| Documentation concern      | Exact page                                              | Create or update        | Planned change                                                                                         | Owning Beads task |
|----------------------------|---------------------------------------------------------|-------------------------|--------------------------------------------------------------------------------------------------------|-------------------|
| Architecture               | `docs/src/architecture/overview.md`                     | Update                  | Document dstack authority layers, lifecycle coordinator, context capsules, and quality-gate boundary.  | `atelier-fon.1`   |
| Development Guide          | `docs/src/development/workflow-commands.md`             | Update                  | Explain Atelier's dstack lifecycle, Beads graph, implementation coordinator, and review/close gates.   | `atelier-fon.2`   |
| Reference                  | `docs/src/reference/contracts.md`                       | Update                  | Define lifecycle, capsule, snapshot/evidence, and quality-gate contract terms and identity boundaries. | `atelier-fon.3`   |
| User Guide                 | `docs/src/user-guide/index.md`                          | Update                  | Present the dstack workflow and interface choice in user language.                                     | `atelier-fon.5`   |
| User Guide                 | `docs/src/user-guide/cli.md`                            | Update                  | Reconcile CLI planning, task, quality-gate, recovery, and closure procedures.                          | `atelier-fon.5`   |
| User Guide                 | `docs/src/user-guide/pi.md`                             | Update                  | Reconcile Pi lifecycle, context, gate, and recovery commands.                                          | `atelier-fon.5`   |
| User Guide                 | `docs/src/user-guide/operations.md`                     | Update                  | Explain snapshots, context freshness, quality-gate failures, and recovery.                             | `atelier-fon.4`   |
| Roadmap                    | `docs/src/planned-features.md`                          | Update                  | Add the canonical feature reference, sequencing, dependencies, and status.                             | `atelier-fon.6`   |
| Navigation                 | `docs/src/SUMMARY.md`                                   | Update                  | Register the design and any future reader-facing pages.                                                | `atelier-fon.6`   |
| Implemented Feature Record | `docs/src/features/first-class-dstack-harness/index.md` | Create during close-out | Record delivered capability, validation, decisions, and audit history.                                 | `docs-reconcile`  |

## Validation Strategy

- Contract and state-transition tests for lifecycle authority, invalid transitions, scope, ownership,
  stale bindings, explicit recovery, and shared CLI/Pi state.
- Pure context-capsule tests for deterministic serialization, source provenance, budgets, redaction,
  digest reuse, invalidation, provider degradation, and omission/truncation reporting.
- Snapshot/recovery tests for crash, restart, compaction, dirty/out-of-scope paths, changed Beads
  state, partial effects, pause, cancel, and explicit Continue.
- Quality-gate fixtures and Git smoke tests from `atelier-k36`, including hooks, signing, filters,
  failure remediation, one-turn bypass expiry, planning inventory, and closure evidence.
- CLI/Pi integration tests for equivalent transitions, compact status, recovery actions, and no
  authority bypass.
- Legacy compatibility tests for old `.atelier` manifests, execution contracts, active grants,
  historical evidence, and restartable migration.
- Documentation checks, markdown/table/style/link checks, typecheck, focused tests, build, and the
  repository-standard suite. External host/provider limitations are recorded explicitly.

## Implementation Decomposition

The lifecycle graph adds the dstack design/review/reconciliation/implementation/documentation/
validation/delivery gates to the existing bounded implementation workstreams. The first
implementation boundary is `atelier-fon.1` after specification reconciliation. Existing
`atelier-k36` remains the quality-gate implementation workstream and retains its child dependency
order.

## Dependencies and Parallelism

The design step precedes four isolated reviews. Specification reconciliation precedes every
implementation workstream. After reconciliation:

- lifecycle orchestration, compact context, and snapshot safety can proceed in parallel;
- quality-gate contract/adapters and Git enforcement follow their internal dependencies and the
  lifecycle authority contract;
- CLI/Pi adapters and migration follow the relevant Core/context/safety and quality-gate slices;
- end-to-end verification waits for adapters, migration, snapshots, and the quality-gate workflow.

## Rollout and Migration

Implement additive readers and evidence schemas first. Keep old validation records readable and
mark them historical/compatibility-scoped. Enable the dstack lifecycle through the existing CLI/Pi
surfaces only after Core can reconstruct equivalent state. Do not remove old writers or delete data
until migration evidence and explicit user-facing recovery paths are complete.

## Risks and Tradeoffs

- A single Core lifecycle coordinator reduces duplicated policy but increases the importance of
  stable contracts and transition tests.
- Compact capsules reduce context cost but can hide necessary evidence if budgets or omission
  reporting are weak; every omitted section must be named and recoverable.
- Automatic quality-gate discovery improves usability but must not execute untrusted commands or
  silently change repository policy.
- Reconciliation of the existing manually created graph may expose stale dependency direction or
  duplicate ownership; the reviewed graph, not historical prose, becomes authoritative.

## Rejected Alternatives

- Keep dstack as agent-only instructions while Atelier maintains a separate lifecycle: rejected
  because it duplicates authority and increases context overhead.
- Dump the complete repository, Beads database, or transcript into every model context: rejected
  because it is unbounded, noisy, and unsafe.
- Treat code-provider results, reports, or snapshots as task authority: rejected because they are
  observations/evidence, not live work state.
- Require users to name validations or bypass Git enforcement for convenience: rejected in favor of
  repository quality-gate discovery and explicit policy-preserving failure handling.
- Automatically resume mutation after restart or recovery: rejected to preserve user control and
  prevent stale-authority effects.

## Open Questions

None block specification reconciliation. Exact module names and adapter decomposition are
implementation details within the stated ownership boundaries. Repository quality-gate precedence
and failure categories are owned by `atelier-k36.1` and must remain compatible with this design.

## Deferred Decisions

- Additional external review hosts or providers are deferred until the Core lifecycle, capsule,
  snapshot, and quality-gate contracts are delivered.
- Numeric context budgets may be tuned from measured evidence, but the existence of explicit
  item/byte/history/retrieval/output limits and omission reporting is not deferred.

## Planning Record

### Questions Asked and Answers

No new blocking question was required. The user's explicit direction established dstack as the
workflow contract and identified code intelligence, Beads, and snapshots as the context-efficiency
and safety mechanisms.

### Assumptions

- The Atelier repository is the implementation repository and `main` is the base branch.
- Existing `atelier-fon` workstreams and `atelier-k36` are intended planning state, not delivered
  behavior.
- Existing reader-facing User Guide pages are the current user documentation boundary and should be
  reconciled rather than duplicated.

### Design Changes During Planning

The initial quality-gate redesign is retained as a child implementation workstream of the broader
dstack harness. Existing root-level workstreams are placed behind the lifecycle specification gate;
no quality-gate requirements are removed.

### Source Material

- dstack workflow skills and `dstack-feature` formula.
- `docs/src/architecture/overview.md` and `docs/src/development/workflow-commands.md`.
- Delivered CLI/Pi, exact-plan, validation/evidence, recovery, and retrieval feature records.
- Beads root `atelier-fon`, implementation workstreams `atelier-fon.1`–`atelier-fon.7`, and quality-gate
  workstream `atelier-k36`.
