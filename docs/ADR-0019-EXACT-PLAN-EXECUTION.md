# ADR-0019: Exact Reviewed-Plan Approval and Task-Scoped Execution

- Status: superseded in part by ADR-0025 and ADR-0027 for capability and revision-binding details
- Date: 2026-07-27

## Context

Atelier needs one workflow that is safe through both the CLI and Pi. A valid Markdown plan alone is insufficient authority: the user must review its exact revision, inspect the exact provider projection, and explicitly decide whether provider mutation and task activation may occur.

Applying reconciliation directly from a fresh preview creates time-of-check/time-of-use risk. Treating task claim, act mode, or routine permissions as implied by a conversational “approve” loses the repository, workspace, provider, and task boundaries needed for safe restart. Conversely, prompting independently for every routine local edit makes approved implementation impractical.

## Decision

### `ManualEdit` is the review boundary

The configured foreground editor begins and completes a durable `ManualEdit`. Atelier records plan hashes, structural snapshots and diff, diagnostics, repository identity, editor outcome, drift, and ambiguity. Only the exact completed and accepted revision may be prepared.

### Preparation is immutable approval input

Preparation stores:

- approval ID and full reviewed plan hash;
- task-provider name/version;
- deterministic reconciliation digest and operation preview;
- repository and workspace identity;
- preparation timestamp and state.

CLI non-interactive approval requires `--approval`, matching `--digest`, and `--yes`. Pi displays the same full plan hash, provider, operations, retirements, and proposed first task before confirmation.

At application time Atelier reparses the plan, recomputes provider reconciliation, and rechecks plan hash, provider identity, digest, repository, workspace, conflicts, and absence of a concurrent execution grant. Mismatch invalidates the preparation before provider mutation.

### Provider reconciliation is convergent and checkpointed

`TaskProvider` remains replaceable; Beads is the default CLI adapter. Reconciliation may adopt a unique stable marker, create, update, link, unlink, or retire. Stable plan IDs, mappings, deterministic operation IDs, and durable checkpoints make retries idempotent. A crash after provider creation can adopt the uniquely marked task rather than duplicate it.

Rejection records an approval and transaction decision but performs zero provider mutation.

### Execution and action permission remain independent

Successful reconciliation claims exactly one approved-plan ready task and creates an execution grant bound to:

- approved plan and reconciliation;
- provider identity;
- repository and workspace;
- provider task and stable plan task.

The execution grant permits act mode but conveys no action permission. File, task, validation, repository, command, network, and publication permissions remain independent. One-operation grants are consumed at authorization attempt.

Pi records implementation-tool mutation outcomes at `tool_result`, not from authorization. Evidence includes success/failure/interruption, before/after repository identity, observed changed paths, and bounded errors. A direct plan-mode write/edit of the designated plan document is intentionally excluded from task execution evidence: no task grant exists yet, and the subsequent `ManualEdit` is its durable review record.

### Continuation is explicit

Task closure revokes the active execution grant and exposes later approved-plan ready work. It does not activate that work. `/execute [task-id]` or `atlr execute [task-id] --yes` revalidates unchanged approval/reconciliation and requires explicit confirmation. `/cancel` revokes execution and linked permissions without changing provider task status or repository content.

### Working State is the restart authority

SQLite, repository identity, and `TaskProvider` state reconstruct workflow checkpoint, approval, reconciliation, current/latest grant, task, permissions, tool evidence, focused selection, current/stale validation, and next action. Conversation text, Pi custom entries, and LLM-authored compaction are non-authoritative.

## Consequences

### Positive

- No provider mutation occurs before an exact user decision.
- Drift and concurrent activation fail closed.
- Reconciliation can recover without duplicate tasks.
- Routine approved local work is usable without weakening destructive or external gates.
- Tool and validation evidence survives Pi/Core restart.
- CLI automation has an explicit stable contract.

### Costs

- Preparation and approval require additional durable records and a second reconciliation preview.
- A changed plan or provider requires a fresh preparation and confirmation.
- Cancellation does not silently repair provider task status; the operator must resume through a fresh exact transaction or explicitly close/defer the task.
- Exact dirty-fingerprint validation freshness is conservative and may require reruns after any source change.

## Rejected alternatives

- **Approve the latest plan text conversationally:** no stable review or TOCTOU boundary.
- **Apply `plan reconcile --apply` directly:** bypasses exact approval and concurrent-state checks.
- **Treat a claimed task as mutation permission:** conflates workflow authorization with least-privilege actions.
- **Infer mutation from authorization:** reports edits that may have failed or been interrupted.
- **Auto-start the next ready task:** hides a new task/workspace authorization decision.
- **Use Pi session entries as authority:** branching and compaction would compete with repository/task/ledger truth.

## Validation

`tests/acceptance-workflow.test.ts` proves semantic outcomes through a temporary Git repository, real foreground fake editor process, persistent fake Beads CLI, configured focused validation, and fake Pi harness. Focused unit/integration suites cover drift, conflicts, partial reconciliation, crash recovery, policy, tool evidence, validation cancellation/staleness, shutdown, and resume. The manual Jujutsu-first gate is documented in `LOCAL_ACCEPTANCE.md`.
