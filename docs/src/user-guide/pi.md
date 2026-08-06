# Pi reference

Start the interactive workflow with:

```sh
atlr launch
```

The extension registers the commands below. Pi's transcript and compaction are
not workflow authority; each agent turn receives reconstructed Atelier Working
State from the shared runtime ledger.

## Plan and approval commands

| Command                                                                    | What it does and what changes                                                                                                                                                                                                                                                      |
|----------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/plan OBJECTIVE`                                                          | Enters guarded plan mode and asks the agent to draft the plan. A completed initial draft can open automatically in the configured editor. Plan mode permits plan editing but not task-provider or source mutation.                                                                 |
| `/plan-scope TASK_ID path1,path2 [validation1,validation2]`                | Updates one task's execution scope in `.atelier/PLAN.md`; validation names are legacy compatibility input. Re-review and prepare after changing it.                                                                                                                                |
| `/review`                                                                  | Waits for idle, opens the current plan, records `ManualEdit`, diagnostics, and reconciliation readiness, then returns to the plan workflow.                                                                                                                                        |
| `/approve`                                                                 | Prepares the exact reviewed transaction, displays its hash, provider, operations, retirements, task constraints, and proposed first task, then asks for confirmation. Rejection performs no provider mutation; approval activates the first task but does not start an agent turn. |
| `/approve --task TASK_ID [--write PATH[,PATH]] [--validation NAME[,NAME]]` | Approves one existing task without a plan. Validation input is optional legacy compatibility data; add `--dependencies`, `--full-suite`, or `--no-local-change` only when intended.                                                                                                |
| `/task-start TASK_ID [--write PATH[,PATH]] [--validation NAME[,NAME]]`     | Explicit standalone-task entry point. Validation input is optional legacy compatibility data; the command is equivalent to standalone `/approve` and asks for confirmation.                                                                                                        |
| `/execute [TASK_ID]`                                                       | Explicitly activates a later ready task from an unchanged approved plan. It requires a prior approved execution and confirmation; it never starts later work automatically.                                                                                                        |

A normal planned Pi sequence is:

```text
/plan Add a small, testable change
/review
/approve
# send an explicit implementation request after approval
/evidence
/review-diff
/commit docs(user-guide): expand CLI and Pi workflows
/close
```

Approval is a transaction, not a prompt to continue. If the plan, repository,
provider, workspace, retrieval binding, or task constraints drift, prepare and
review again instead of reusing a stale confirmation.

## State and navigation commands

| Command                     | What it does                                                                                                                                   |
|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `/status`                   | Shows workflow, plan, task, repository, quality-gate, provider, and policy status as a persistent report.                                      |
| `/workflow`                 | Shows concise durable ledger/workflow state without a provider-backed full rebuild.                                                            |
| `/workflow full`            | Reconstructs full Working State, including retrieval-backed diagnostics. `refresh` and `--full` are equivalent full requests.                  |
| `/state`                    | Compatibility alias for `/workflow`; it accepts the same `full`, `refresh`, and `--full` forms.                                                |
| `/ready [TASK_ID]`          | Shows provider-reported ready tasks. With an exact ID, or a UI selection, records that task as selected; selection alone does not activate it. |
| `/performance [clear]`      | Shows bounded interactive, subprocess, hashing, cache, and SQLite timing diagnostics. `clear` removes the current session samples.             |
| `/atelier-open PATH[:LINE]` | Opens a repository path at an optional line in the configured editor.                                                                          |
| `/atelier-files`            | Selects a tracked repository file and opens it in the configured editor.                                                                       |
| `/atelier-tree`             | Opens Yazi when available in a TUI; otherwise shows a bounded project tree above the editor.                                                   |
| `/changed`                  | Shows current repository paths changed from the provider baseline.                                                                             |

Use `/status` for a quick answer. Use `/workflow full` when a provider-backed
reconstruction or retrieval freshness detail is needed. A report card stays in
Pi scrollback but is presentation only; the next `before_agent_start` rebuilds
the authoritative state.

## Stop, pause, resume, and cancel

| Command                          | Transition and recovery                                                                                                                                           |
|----------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/atelier-stop`                  | Aborts only the current Pi agent/tool turn. The active task and execution grant remain available. It does not revert source files or schedule a forced follow-up. |
| `/atelier-pause [reason]`        | Persists a paused execution, keeps the task active, disables agent mutation, and aborts the current turn. Repository reads remain possible.                       |
| `/atelier-resume`                | Re-enables a paused execution without starting an agent turn. Send a new implementation request when ready.                                                       |
| `/atelier-resume-task [TASK_ID]` | Resumes a cancelled approved task after exact plan, provider, workspace, and source-baseline checks. Existing changes and stale evidence are preserved.           |
| `/cancel [reason]`               | Atomically revokes the active execution and aborts the current turn without waiting for idle. The task stays open and source changes stay in place.               |

When Pi starts with an active execution after a restart, Atelier presents Pi's native recovery selection dialog. It shows the recovered task and preserves existing changes. Use the arrow keys and **Enter** to choose Continue task (one explicit continuation turn), Pause, or Cancel; press **Esc** to leave the task idle. This is not a second approval, and Atelier never starts a mutating model turn without the explicit Continue action.

After a pause, run `/status` and `/workflow` before resuming. After a cancel,
inspect the existing diff and evidence, then use `/atelier-resume-task` only if
the exact approved baseline still makes the task attributable. If it does not,
review and approve a fresh transaction.

## Quality gates and compatibility evidence

| Command           | What it does                                                                                                                                               |
|-------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/dstack gates`   | Shows the discovered repository checks, policy identity, and planning coverage.                                                                            |
| `/evidence`       | Shows current quality-gate evidence and any historical compatibility evidence.                                                                             |
| `/review-diff`    | Displays the exact task diff and asks for confirmation before recording its hash-bound final-diff review.                                                  |
| `/commit MESSAGE` | Runs the approved quality gate, then creates the one task-scoped local Git commit or Jujutsu change.                                                       |
| `/close [reason]` | Runs the approved quality gate again and requests closure only when current gate, diff, local-change, and repository-state evidence satisfy the predicate. |

The legacy `/validate`, `/validate plan`, `/validate focused`, and
`/validate NAME` commands remain available for compatibility inspection. Their
results are marked historical when the active execution uses quality gates; a
new task does not need validation names. Do not treat a green-looking
compatibility result or unchanged report card as current gate evidence.

## Code-intelligence commands

| Command                    | What it does                                                                                                  |
|----------------------------|---------------------------------------------------------------------------------------------------------------|
| `/code-status`             | Reports provider health, capabilities, index state, retrieval inventory, and local database-lock diagnostics. |
| `/code-index`              | Ensures the configured workspace index exists or joins the current index operation.                           |
| `/code-search QUERY`       | Runs a semantic search through the configured provider and presents provenance and inventory details.         |
| `/code-symbols IDENTIFIER` | Performs an explicit human-requested symbol lookup and presents definition/reference results.                 |

Use `/code-status` before another request. Read returned paths directly. For
local codesearch, a reported lock includes the owning PID; close its Pi/Atelier
session before `/code-index` or another search. Atelier does not terminate
processes automatically. The provider-first recommendation is advisory: if
the provider is unavailable, stale, excluded, or out of budget, use an exact
typed read or an explicitly authorized shell inspection. `/code-symbols` is an
explicit human command; the model-facing `atlr_code_symbols` tool has the
stricter unresolved-inventory precondition.

## The model-facing typed tools

These are not slash-commands, but they are part of the Pi integration:

- `atlr_state` reads authoritative Working State.
- `atlr_validate` plans or runs declared validation operations.
- `atlr_commit` creates the approved task-scoped local change.
- `atlr_task_close` requests closure after the completion predicate passes.
- `atlr_code_status`, `atlr_code_search`, and `atlr_code_symbols` provide
  inventory-gated code intelligence to the model.

Use the typed tools instead of Bash or raw VCS commands for state, declared
validation, the approved commit, and task closure. A user's current instruction
not to validate, commit, close, use Bash, or continue overrides a reviewed task
constraint.

## Pi-only behavior and boundaries

Pi reserves `/trust` for Pi-owned project resources. Atelier does not register
an Atelier trust command. The extension also does not turn a successful
approval into an automatic model turn. This keeps the person in control after
an exact transaction is applied.

The footer and report cards are passive presentation. If the transcript is
compacted, or a session restarts, Atelier revalidates execution bindings and
reconstructs state from the external ledger. If a provider fails, the workflow
stops closed and the next action is shown by `/status` or `/workflow`.
