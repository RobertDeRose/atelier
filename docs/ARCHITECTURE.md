# Atelier Architecture

## Product boundary

Atelier is a local-first Agentic Development Environment. The CLI is `atlr`; the supported interactive shell is Pi launched through `mise run launch`.

Atelier owns workflow orchestration, policy, exact approval, retrieval budgets and reuse, durable evidence, and Working State. External tools retain their own responsibilities:

- editors own text editing;
- Jujutsu is the primary repository model and Git is the compatibility boundary;
- `TaskProvider` implementations own task storage, with Beads as the default;
- code providers own parsing and indexing, with codesearch as the default and Octocode optional;
- configured commands own validation behavior.

Atelier does not infer authority from conversation text, Pi custom entries, provider output, or an LLM-authored compaction summary.

## Delivered topology

The current implementation is an in-process TypeScript Core used by both the CLI and Pi extension:

```text
atlr CLI ─────────────┐
                      v
Pi extension ──> AtelierCore
                      ├── PolicyEngine
                      ├── ExecutionWorkflowCoordinator
                      ├── PlanReviewService / ManualEdit
                      ├── PlanReconciler / TaskProvider
                      ├── RepositoryProvider (Jujutsu, then Git)
                      ├── ValidationService
                      ├── CodeService / CodeProviderRegistry
                      ├── WorkingStateBuilder
                      └── SqliteLedger
```

A daemon or transport boundary is not delivered. It remains a possible future extraction, not a source of current behavior.

## Authority boundaries

### Before execution

```text
Reviewed .atelier/PLAN.md revision = human-facing scope authority
Prepared reconciliation preview   = exact proposed provider mutation
TaskProvider graph                 = provider state to reconcile, not approval
```

A plan revision becomes executable only after a completed `ManualEdit`. Preparation stores the full plan hash, provider identity, reconciliation digest, operation list, workspace, and repository. Approval rechecks all of them. A changed plan, provider, reconciliation, workspace, repository, conflict set, or concurrent execution invalidates the preparation before provider mutation.

### During execution

```text
Approved plan revision = reviewed scope baseline
TaskProvider graph      = task status, dependencies, blockers, and ready work
Execution grant         = authorization for exactly one task/workspace
Permission grant        = independent authorization for an action
Repository source       = authority for current code behavior
```

An execution grant never implies a file, task, validation, repository, network, or publication permission. Policy requires both the active task-bound execution grant and the action-specific permission. One-operation permissions are consumed when authorization is attempted, regardless of the eventual tool result.

### After tool execution

Pi's `tool_call` hook performs blocking preflight. Its `tool_result` hook records `succeeded`, `failed`, or `interrupted` execution evidence with before/after repository identity, observed changed paths, and bounded errors. Authorization alone is never represented as an observed edit.

## Exact reviewed-plan workflow

```text
Draft plan
  -> configured editor
  -> durable ManualEdit + structural diff + diagnostics
  -> provider reconciliation preview
  -> exact preparation
  -> explicit reject or approve
  -> provider operations converge
  -> first approved-plan task is claimed
  -> task-scoped execution grant enters act mode
```

Rejection performs no provider mutation. Reconciliation supports create, adopt, update, dependency link/unlink, and retirement. Operations are deterministic and checkpointed so a restart cannot silently duplicate task creation.

Later ready work is never activated automatically. Explicit task closure revokes the old execution grant and exposes approved-plan ready tasks. `/execute [task-id]` or `atlr execute [task-id] --yes` creates a new task-scoped grant only after confirmation and revalidation. `/cancel` revokes execution and linked permissions without closing or altering the task.

See [ADR-0019](ADR-0019-EXACT-PLAN-EXECUTION.md).

## Working State

Working State is deterministic reconstruction from durable state:

- current or latest execution grant and workflow checkpoint;
- exact plan approval and reconciliation transaction;
- current task, approved-plan ready tasks, direct dependencies, and blockers;
- active permissions;
- `ManualEdit` and mutating-tool evidence;
- current and stale validation evidence;
- repository snapshot and changed paths;
- bounded code evidence with provider provenance and freshness;
- corrections, findings, decisions, omissions, and the next action.

`before_agent_start` injects this projection. `session_before_compact` supplies the same authoritative state in the compaction summary. A fresh Core/Pi process reconstructs it from SQLite, the repository, and the task provider rather than from conversation history.

## Validation

Focused validation selection records changed paths/symbols, selected checks, reasons, required flags, task/execution/plan bindings, and the pre-run snapshot. Commands execute directly from argument arrays with bounded output and abort-aware process-tree termination.

Evidence is current only when its repository fingerprint exactly matches the present fingerprint. A later source change makes a prior pass visibly stale; stale, failed, or interrupted evidence cannot satisfy task closure. Focused and full-suite validation use independent permissions, and a focused no-match never promotes to a full suite.

## Code intelligence

Atelier owns the provider-neutral contract, capability gating, orchestration, session budgets, deduplication, provenance, freshness, and reuse. Providers own indexing and retrieval implementation.

```text
CodeService
  ├── codesearch [default]
  ├── Octocode [optional, capability-gated]
  ├── mock [tests]
  └── disabled [deterministic fallback]
```

Retrieval sessions are isolated by provider, workspace, repository scope, repository revision, and index revision. Equivalent queries reuse current evidence; revision drift invalidates affected evidence. Multi-repository results never cross requested scopes.

## Repository and persistence model

Jujutsu snapshots include repository, workspace, change, commit, operation, dirty generation, and dirty fingerprint. Git snapshots provide the compatibility equivalent. The SQLite ledger migrates in place and stores workflow runs, `ManualEdit`, exact approvals, reconciliation transactions/checkpoints, execution and permission grants, tool evidence, validation selection/evidence, task mappings, and bounded retrieval checkpoints.

`.atelier/PLAN.md`, `.atelier/atelier.db`, task-provider state, provider indexes, and legitimate working-copy changes are independent assets. Update and restart procedures must preserve all of them.
