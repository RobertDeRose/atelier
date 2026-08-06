# Shared state, validation, and recovery

This page explains what remains true when work moves between CLI and Pi, how
closure evidence is built, and how to recover from common failures.

## One workflow, two clients

CLI and Pi share these authorities:

- project configuration under `.atelier/`;
- the selected repository and optional workspace roots;
- the Git or Jujutsu repository provider;
- the configured task provider and its task state;
- the external Atelier SQLite ledger containing approvals, execution grants,
  Working State inputs, mutation evidence, validation evidence, and recovery
  checkpoints; and
- code-provider identity, index freshness, retrieval provenance, and budgets.

Each Pi session owns a session-local Core instance and retrieval session. A CLI
invocation opens Core for the same repository and ledger, and a local Core
service can keep one server process available to CLI clients. The process
boundary does not create a second approval policy. It does mean that a client
can observe stale external changes until its next status/observation request.
Refresh before a sensitive operation and avoid concurrent mutating clients.

Prefer Pi for interactive implementation, editor handoff, report cards, and
turn controls. Prefer CLI for scripts, JSON, provider diagnostics, recovery
listing, non-TUI editor use, and exact service operations. Switching is safe
when the previous client is idle and the next client starts with `atlr status`
or `/status` plus `/workflow` as needed.

## Workflow modes and state transitions

Atelier uses three guarded modes:

| Mode          | Allowed purpose                                                                     |
|---------------|-------------------------------------------------------------------------------------|
| `investigate` | Read and inspect; mutations require a distinct authorization.                       |
| `plan`        | Draft and review `.atelier/PLAN.md`; task-provider and source mutations are denied. |
| `act`         | Implement only the selected task and reviewed task constraints.                     |

An approved plan transaction moves the first task into `act` with an execution
grant. Approval rejection, plan drift, provider conflict, or source-baseline
drift does not enter act mode. A pause keeps the grant and task but blocks
agent mutation. Cancellation revokes the grant while leaving the task open.
Closing the task invalidates the grant and exposes later approved-plan ready
work without starting it.

Read the next action rather than inferring it from a transcript:

```sh
atlr state --json
```

```text
/status
/workflow full
```

## Validation evidence and closure

A validation is a named definition in `.atelier/validation.json`. Its command
is an argument array with bounded, redacted output. A focused selection is
based on changed paths and symbols; it is not a disguised full-suite request.
Every result is tied to a repository snapshot and becomes stale after relevant
source changes.

The authoritative closure predicate requires all configured conditions:

1. required validations are current and passing;
2. the exact current baseline diff has been reviewed;
3. the task-scoped local Git commit or Jujutsu change exists when required;
4. required source paths are clean; and
5. the configured repository cleanliness requirement holds.

Inspect blockers with:

```sh
atlr state
atlr validate plan
atlr evidence
atlr repo status
atlr changed
```

```text
/status
/workflow full
/validate plan
/evidence
```

If no required validation is configured while `requireValidation` is true,
Atelier correctly reports that closure has no valid validation path. Add a
reviewed named validation to the project manifest and task contract; do not
substitute an unrecorded shell command.

## Recovery semantics

Atelier does not silently revert source when a turn stops, a task is cancelled,
or validation fails. Dirty tracked files and practical untracked/ignored
content that a destructive operation could discard receive an exact Git or
Jujutsu checkpoint before that operation. Checkpoints are stored under the
external runtime directory and record the initiating session, tool call,
provider state, affected paths, and verification result.

When a task is active, the checkpoint also records the task execution baseline:
task and plan identity, execution grant, repository/workspace identity, source
snapshot and bindings, reviewed scope, validation contract, and task ownership.
Evidence, diff review, and validation records retain the same baseline digest so
an observation cannot be reused for a different task boundary.

List or restore checkpoints from the CLI:

```sh
atlr recovery list --json
atlr recovery restore CHECKPOINT_ID
```

Restore only after inspecting the checkpoint and current diff. A restore is a
source mutation and may overwrite work that appeared after the checkpoint;
make a separate copy or local VCS checkpoint first when attribution is unclear.
Restoring a checkpoint for an active task pauses that execution before the
restore. `atlr resume` or `/atelier-resume` rechecks the repository, workspace,
source-base, index, and scope baseline before unpausing; drift invalidates the
grant instead of resuming mutation. Continue is always an explicit action.
A failed checkpoint blocks the destructive operation rather than proceeding
without recovery.

## Failure-oriented playbook

### `doctor` reports `Degraded`

Run `atlr doctor --json` and fix the named issue. Common causes are missing
Node 24, Git/Jujutsu, Pi, Beads, or an editor. A missing project file is fixed
by `atlr launch`; a missing task provider can be initialized with
`atlr init --beads`. `doctor` itself is safe to run repeatedly.

### Approval says the plan or digest is stale

Do not reuse the old approval ID or digest. Run `atlr review`, then
`atlr plan prepare --json`, inspect the new transaction, and approve the new
values. In Pi, run `/review` and `/approve` again. This is expected after plan,
repository, provider, task, workspace, or reviewed-scope changes.

### Reconciliation has conflicts or the provider is unavailable

Inspect the conflict with `atlr plan reconcile --json` or `/workflow full`.
Resolve task identity, dependency, or plan metadata conflicts in the owning
provider or reviewed plan, then complete a fresh `/review` and preparation.
Initialize Beads separately when Pi asks; do not manually claim a task with
`bd` or an unapproved provider command.

### Work is paused, cancelled, or interrupted

For a pause or restored checkpoint, inspect `/status`, then `/atelier-resume` or
`atlr resume`; the resume action revalidates the exact execution baseline. For a
cancelled approved task, inspect source and evidence before
`/atelier-resume-task` or `atlr resume-task`. Escape, denial, and normal turn
settlement do not schedule a forced follow-up. Existing source edits remain
available for review; cancellation is not a revert.

### Validation fails, is interrupted, or is stale

Read `/evidence` or `atlr evidence`. Rerun the exact named validation with
`/validate NAME` or `atlr validate run NAME`; use `/validate focused` or
`atlr validate focused` only after reviewing the current selection. An
interrupted result is neither pass nor failure. Fix the source, then plan and
rerun the relevant checks; never rely on a pass recorded before the last source
change.

### Closure is blocked

Read `atlr state` or `/workflow full`; it reports the missing predicate. The
usual sequence is:

```sh
atlr validate focused
atlr repo review-diff
atlr repo commit --message "type(scope): summary"
atlr task close TASK_ID --reason "Evidence-backed completion"
```

In Pi use `/validate focused`, `/review-diff`, `/commit MESSAGE`, and `/close`.
If a required local change or clean-source check cannot be satisfied, stop and
resolve the repository state instead of force-closing the task.

### The editor opens and immediately exits

Use a foreground editor and, for GUI editors, a wait flag:

```sh
ATLR_EDITOR='code --wait' atlr review
```

Run `atlr doctor` to see the resolved source. From a non-TUI Pi session, run
`atlr review` in a normal terminal. Do not put an editor executable in the
repository `.atelier/config.json`.

### Code search is unavailable, stale, or out of budget

Run `atlr code status` or `/code-status`. For local codesearch, status also
checks whether another process holds `.codesearch.db` and reports the owning
PID when the operating system exposes it. Close the owning Pi/Atelier session
(or resolve a stale `codesearch` process) before retrying `atlr code index` or
`/code-index`; Atelier does not terminate processes automatically. Reindex
when the index is stale. Start a new Pi retrieval session after a genuine
request-budget exhaustion, or read a known path directly. Provider routing is
advisory; a degraded provider does not authorize broad access or make stale
results current.

### Shell execution requests an approval

Check `atlr sandbox status`. Missing OS confinement, likely-secret access,
privilege escalation, outside-workspace paths, and indeterminate destructive
effects intentionally require a concrete consequence approval or are denied.
Use typed Atelier tools for state, validation, commit, and closure. Never put
credentials in a command merely to avoid a policy prompt.

### Runtime state appears missing

Check `ATLR_STATE_HOME`, `XDG_STATE_HOME`, `ATLR_USER_CONFIG`, and the root used
to launch the process. Run `atlr doctor --json` and `atlr status` from the same
repository/workspace. Do not copy or delete `atelier.db` while Pi is running;
restart the client after correcting the state location so Core can revalidate
bindings. Runtime state is user-owned and is not expected inside `.atelier/`.

## Retained evidence and services

Inspect retained data before maintenance:

```sh
atlr data inspect
atlr data export
atlr data prune --days 30 --keep 1000
```

`atlr data delete --yes` is an explicit destructive operation for retained
historical evidence. It does not close tasks, revoke a valid workflow, or
restore source files.

For a long-lived local Core process:

```sh
atlr serve --socket /tmp/atelier.sock
atlr service --socket /tmp/atelier.sock status
atlr service --socket /tmp/atelier.sock state
atlr service --socket /tmp/atelier.sock stop
```

Use a socket path that is inside the intended local runtime boundary. The
service does not change approval or workspace policy; it only provides a local
request surface for the same Core contracts.

## Further reading

- [Architecture overview](../architecture/overview.md) describes ownership and
  runtime boundaries.
- [Exact plan format](../features/exact-plan-execution/plan-format.md) defines
  task execution contracts and approval bindings.
- [Code intelligence and retrieval](../features/canonical-retrieval-planning/code-intelligence/index.md)
  defines provider scope, provenance, and budgets.
- [Development setup](../development/setup.md) covers the contributor toolchain.
