# Historical UI Latency Audit — 0.14.0-alpha.29

> This dated audit is retained as evidence. Current lifecycle and presentation
contracts are defined by the architecture pages and ADRs.

## Scope

This audit covers commit `995ccce96d9d60030cdfc051904f024693eda03d`, tag `v0.14.0-alpha.29`, with emphasis on:

- `/status`
- `/workflow` and `/state`
- exact plan approval through `/approve`
- workspace permission prompts for typed tools and Bash
- the delay before Pi shows any visible progress

The audit used static call-path analysis plus an instrumented synthetic latency experiment. It did not profile the user's Mac directly.

## Verdict

The reported 5-second pauses are explained by the current architecture. They are not primarily a rendering problem.

The dominant causes are:

1. Slash commands trigger duplicate or triplicate full status calculations.
2. A full status calculation fans out into many Git/Jujutsu and Beads subprocesses.
3. Git and Jujutsu observations use `spawnSync()`, blocking Pi's only JavaScript/UI thread.
4. Repository snapshots synchronously hash every source file, repeatedly.
5. Active-task status recomputes the expensive closure predicate three times.
6. `/workflow` performs provider reads and may execute code-intelligence retrieval instead of rendering only durable state.
7. Permission evaluation performs full snapshots before the prompt, after approval, before execution evidence, and again for the footer.
8. No progress indicator is installed before the expensive work begins.

The result is a UI that appears frozen even when Atelier is actively doing work.

## Synthetic latency experiment

I wrapped Git and Beads so that every external process took only 100 ms, then exercised alpha.29 with a clean Git repository, Beads enabled, code intelligence disabled, and no active task.

| Operation                                            |   Time |      Child processes |
|------------------------------------------------------|-------:|---------------------:|
| One `core.status()`                                  | 1.31 s |  12: 9 Git + 3 Beads |
| A `/status`-like three-status sequence               | 3.99 s | 36: 27 Git + 9 Beads |
| `buildWorkingState()` plus one footer status refresh | 3.63 s | 34: 30 Git + 4 Beads |

This deliberately simple model reproduces the reported delay. With Jujutsu, codesearch enabled, an active task, a multi-repository workspace, filesystem contention, or a slow provider, the path is heavier.

## Findings

| ID     | Severity | Finding                                                                                                                                                                           | User-visible effect                                                                                |
|--------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| LAT-01 | Critical | `/status` computes status directly and then recomputes it for the footer. The global input hook also requests a refresh before slash-command dispatch.                            | Two to three full observations for one command.                                                    |
| LAT-02 | Critical | Git and Jujutsu providers use synchronous child processes.                                                                                                                        | Pi cannot repaint, animate, accept input, or show a prompt while VCS observation is running.       |
| LAT-03 | Critical | Every repository snapshot hashes the complete source inventory synchronously.                                                                                                     | Repeated disk reads on every status, footer refresh, authorization event, and evidence transition. |
| LAT-04 | Critical | Active-task status invokes `taskClosureReadiness()` three times.                                                                                                                  | Status cost increases dramatically once a task is active.                                          |
| LAT-05 | Critical | `taskClosureReadiness()` repeatedly reconstructs workspace providers, snapshots repositories, computes diffs, checks local changes, checks cleanliness, and reads metadata state. | Dozens of VCS calls for one status request.                                                        |
| LAT-06 | Critical | `/workflow` calls `buildWorkingState()`, which can contact Beads, codesearch, and execute semantic/symbol retrieval.                                                              | A supposedly observational command may wait on external providers and indexing locks.              |
| LAT-07 | Critical | Permission prompts are displayed only after classification and multiple full snapshots.                                                                                           | Long blank pause before the confirmation dialog appears.                                           |
| LAT-08 | Critical | After permission approval, Atelier performs more snapshots, starts durable evidence, and awaits a full footer refresh before returning control to the tool.                       | Long blank pause after clicking Approve.                                                           |
| LAT-09 | High     | Exact `/approve` performs repeated provider status/list/reconciliation passes before and after confirmation.                                                                      | Approval can take several seconds before the summary and again after approval.                     |
| LAT-10 | High     | `/approve` refreshes status inside `approveAndReconcile()` and again in the command's `finally`.                                                                                  | Two expensive post-approval refreshes, plus the input-triggered refresh.                           |
| LAT-11 | High     | Footer refreshes are serialized but not debounced or cached. New requests force another loop pass.                                                                                | Refresh storms during tool, agent, model, thinking, index, and command events.                     |
| LAT-12 | High     | Thinking-level and model changes trigger a complete repository/task/provider status refresh.                                                                                      | A cosmetic footer update pays the full status cost.                                                |
| LAT-13 | High     | With code intelligence enabled, every footer refresh computes a new workspace source digest through `core.codeWorkspace()`.                                                       | One additional full repository snapshot and tree hash per footer refresh.                          |
| LAT-14 | High     | Beads `status()` launches `bd version`, `bd where --json`, and `bd list --json` every time, with no session cache.                                                                | Three subprocesses for every status observation before reading the current task.                   |
| LAT-15 | High     | Repository-provider auto-selection is repeated for secondary repositories.                                                                                                        | Each workspace reconstruction can run Jujutsu and Git detection again.                             |
| LAT-16 | Medium   | Codesearch `status()` synchronously probes `--version`, may start/connect MCP, and reads provider status.                                                                         | `/workflow` can pay process startup and IPC costs.                                                 |
| LAT-17 | Medium   | Recovery checkpoints use synchronous recursive filesystem copying and VCS capture/verification.                                                                                   | Checkpoint-based approvals can appear frozen, especially for directories or large files.           |
| LAT-18 | Medium   | SQLite is synchronous and configured with `busy_timeout = 5000`.                                                                                                                  | A competing writer can produce an exact multi-second pause; likely secondary, but worth tracing.   |
| LAT-19 | Medium   | Git/Jujutsu synchronous process calls have no timeout.                                                                                                                            | A provider lock or hung command can freeze Pi indefinitely.                                        |
| LAT-20 | Medium   | There is no phase timing or subprocess-count telemetry for interactive operations.                                                                                                | Slow phases are invisible and regressions are difficult to localize.                               |

## Detailed call paths

### `/status`

The command handler performs:

1. `core.status()` for the report.
2. `updateStatus()` for the footer, which calls `core.status()` again.
3. The `input` event has already requested another footer refresh before recognizing that the input is a slash command.

Relevant code:

- `apps/pi-extension/src/index.ts:655-660`
- `apps/pi-extension/src/index.ts:962-968`
- `apps/pi-extension/src/footer-status-controller.ts:118-137`
- `apps/pi-extension/src/footer-status-controller.ts:158-179`

A no-active-task Git/Beads `core.status()` launches:

- Beads: `version`, `where --json`, `list --json`
- Git snapshot: repository root, HEAD, common directory, status, file inventory
- Git display state: repository root, branch, short HEAD, status

That is 12 child processes before any active-task closure work.

For Jujutsu/Beads, the equivalent baseline is approximately 15 processes.

### `core.status()` with an active task

`core.status()` calculates closure status using `taskClosureReadiness()` twice in one expression, then `nextAction()` calculates it a third time.

Relevant code:

- `packages/core/src/core.ts:1117-1131`
- `packages/core/src/core.ts:1167-1229`

Each closure calculation can perform:

- workspace reconstruction
- primary and secondary repository snapshots
- validation evidence matching
- changed-path observation
- per-path diff construction
- local-change detection
- source-clean checks
- metadata-dirty checks

Relevant code:

- `packages/core/src/core.ts:721-803`
- `packages/core/src/repository/workspace-repository-service.ts:102-119`
- `packages/core/src/repository/workspace-repository-service.ts:122-186`
- `packages/core/src/repository/workspace-repository-service.ts:219-253`

`WorkspaceRepositoryService.evidenceSnapshot()` snapshots the primary repository once, then `currentBindings()` snapshots it again. Creating the service already called `codeWorkspace()`, which snapshots it again.

### `/workflow`

`/workflow` is not currently a ledger-only status view. It calls `buildWorkingState()` and then performs another footer refresh.

Relevant code:

- `apps/pi-extension/src/index.ts:1178-1189`
- `packages/core/src/core.ts:1065-1114`

`WorkingStateBuilder.build()` can:

- run `bd ready`
- run `bd show` for the active task and each dependency
- call code-provider status
- create a repository-state plan
- execute semantic code searches or symbol queries

Relevant code:

- `packages/core/src/state/working-state-builder.ts:57-120`
- `packages/core/src/state/working-state-builder.ts:128-220`
- `packages/core/src/state/working-state-builder.ts:387-483`

This is the wrong cost model for an interactive status command.

### Workspace permission prompt

For a model tool, the common authorization path is:

1. `requestForTool()` captures a full repository snapshot.
2. Workspace policy classifies every affected path through the VCS provider.
3. The policy-decision ledger event captures another full snapshot.
4. If recoverability requires a checkpoint, Atelier creates and verifies it before showing the confirmation in some paths.
5. Only then does `ctx.ui.confirm()` appear.
6. The approval/denial ledger event captures another full snapshot.
7. Mutation execution evidence captures another snapshot and changed paths.
8. The tool-call handler awaits a full footer refresh before allowing the tool to start.

Relevant code:

- `apps/pi-extension/src/tool-authorization.ts:22-48`
- `apps/pi-extension/src/tool-authorization.ts:158-207`
- `apps/pi-extension/src/index.ts:669-732`
- `packages/core/src/core.ts:350-410`
- `packages/core/src/core.ts:1237-1250`

For one tracked Git path, `classifyPath()` itself normally runs three commands: repository root, `ls-files`, and path-specific status.

Relevant code:

- `packages/core/src/repository/git-repository-provider.ts:173-184`
- `packages/core/src/repository/jujutsu-repository-provider.ts:191-201`

The delay after clicking Approve is therefore expected from the current implementation.

### Exact plan approval

Before showing the transaction confirmation, `/approve` performs a provider preflight and `execution.prepare()`.

The successful path performs at least seven task-provider status checks and four full task-list reads across UI preflight, preparation, revalidation, application, and convergence. Since Beads status itself runs three processes, this produces at least 25 Beads processes before counting reconciliation mutations and task claiming.

Relevant code:

- `apps/pi-extension/src/index.ts:286-350`
- `packages/core/src/workflow/execution-workflow-coordinator.ts:105-178`
- `packages/core/src/workflow/execution-workflow-coordinator.ts:181-278`
- `packages/core/src/planning/plan-reconciler.ts:135-162`
- `packages/core/src/planning/plan-reconciler.ts:306-355`

After approval, status is refreshed inside `approveAndReconcile()` and again by the outer `/approve` handler.

Relevant code:

- `apps/pi-extension/src/index.ts:339-347`
- `apps/pi-extension/src/index.ts:1031-1039`

## Why no indication appears

The UI and Atelier extension run on the same Node/Bun event loop. Git and Jujutsu observations call `spawnSync()`. While one of those calls is running, Pi cannot repaint a spinner or even display a status string that was just scheduled.

The current handlers also do not install a working indicator before beginning the expensive phases. The approval dialog is invoked only after policy evaluation, snapshots, ledger writes, and sometimes checkpoint creation.

A cosmetic progress change alone will not solve this. The provider calls need to become asynchronous for responsive progress updates.

## Recommended correction order

### P0 — remove duplicate work and show immediate phase feedback

1. **Make `/status` a single-observation command.**
   - Call `core.status()` once.
   - Use that exact result for both the report and footer.
   - Do not call `updateStatus()` afterward.

2. **Do not refresh on the global input hook for slash commands.**
   - Parse input first.
   - Let each slash handler own its one required refresh.
   - Debounce ordinary-input refreshes.

3. **Compute closure readiness once.**
   - Calculate one `TaskClosureReadiness` in `core.status()`.
   - Derive both `closureStatus` and `nextAction` from it.

4. **Remove duplicate `/approve` footer refreshes.**
   - Refresh once after the transaction reaches a terminal state.

5. **Do not await footer refresh in `tool_call`.**
   - Authorization should return immediately after durable evidence is established.
   - Refresh after `tool_result`, or schedule a non-blocking stale-while-revalidate update.

6. **Add phase indicators before slow work.**
   - `Reading repository state…`
   - `Evaluating operation effects…`
   - `Creating recovery checkpoint…`
   - `Revalidating approved transaction…`
   - `Applying task reconciliation…`
   - Yield once before beginning work so Pi can render the indicator.

7. **Update model/thinking text without full status observation.**
   - Mutate the footer component's live runtime state and invalidate only that component.

### P1 — eliminate event-loop blocking and subprocess fan-out

8. **Convert Git and Jujutsu providers to asynchronous process execution.**
   - Reuse the existing bounded `runProcess()` abstraction.
   - Add `AbortSignal`, startup/idle/total timeouts, and process-group termination.

9. **Introduce one request-scoped `RepositoryObservation`.**
   - One observation should contain identity, display state, source fingerprint, changed paths, path states, and metadata paths.
   - Reuse it throughout one command or authorization transaction.

10. **Cache immutable repository facts.**
    - repository root
    - Git common directory
    - Jujutsu workspace root
    - provider selection for every workspace repository

11. **Stop hashing the complete tree on every snapshot.**
    - For clean Git, use the tree/HEAD identity.
    - For dirty state, hash only changed and untracked source paths plus their content/metadata.
    - Apply the equivalent Jujutsu strategy.

12. **Batch path classification.**
    - Build one VCS path-state map for all effects rather than launching several commands per path.

13. **Deduplicate workspace snapshots.**
    - `codeWorkspace()`, `evidenceSnapshot()`, and `currentBindings()` should share one captured snapshot per repository.

### P1 — separate status rendering from provider discovery

14. **Make `/workflow` observational by default.**
    - Add `buildWorkingState({ retrieve: false, refreshProviders: false })`.
    - Render persisted retrieval evidence and ledger state only.
    - Put new retrieval behind `/workflow refresh`, code tools, or the agent-turn planning path.

15. **Cache Beads capability and initialization state.**
    - Cache `bd version` for the process lifetime.
    - Cache `bd where` until initialization or repository replacement.
    - Do not run `bd list` merely to determine status.

16. **Cache code-provider status.**
    - Avoid starting or reconnecting MCP for routine footer/status rendering.
    - Provider lifecycle events should update cached state directly.

### P2 — simplify permission and approval transactions

17. **Capture one authorization observation.**
    - Reuse it for the workflow request, workspace decision, ledger events, approval result, and execution evidence.
    - Do not attach a newly recomputed full snapshot to each event.

18. **For explicit checkpoint approval, prompt before doing expensive checkpoint work.**
    - Ask: `Create a checkpoint and allow this operation once?`
    - On approval, show `Creating checkpoint…`, create it, then continue.
    - Automatic recoverable operations may still checkpoint without a prompt, but must show progress.

19. **Reduce exact-approval provider passes without weakening exactness.**
    - Preparation should persist one provider snapshot/digest.
    - Approval should perform one fresh revalidation read before mutation.
    - Application should perform one convergence read afterward.
    - `PlanReconciler.apply()` should accept the already revalidated provider inventory rather than calling `preview()` again internally.

20. **Instrument SQLite lock waits.**
    - Log waits above 50 ms.
    - Distinguish DB lock delay from provider delay.
    - Review whether Pi and the local Core service can write the same ledger concurrently.

## Performance instrumentation to add

Add a structured span around every interactive operation:

````text
operation=/status phase=task_provider.status duration_ms=...
operation=/status phase=repository.snapshot duration_ms=... subprocesses=...
operation=/status phase=closure.readiness duration_ms=...
operation=/workflow phase=code.status duration_ms=...
operation=permission phase=effect.classification duration_ms=...
operation=permission phase=checkpoint duration_ms=...
operation=/approve phase=reconciliation.preview duration_ms=...
````

Include:

- total wall time
- time until first visible UI feedback
- subprocess count by executable
- bytes and files hashed
- SQLite lock-wait time
- cache hit/miss state
- whether a footer refresh was coalesced, skipped, or repeated

## Proposed latency budgets

| Interaction                                 | First visible indication | Cached completion |                                Uncached completion |
|---------------------------------------------|-------------------------:|------------------:|---------------------------------------------------:|
| `/status`                                   |                  < 50 ms |          < 100 ms |                                           < 500 ms |
| `/workflow` default                         |                  < 50 ms |          < 150 ms |                                           < 500 ms |
| Permission prompt for one path              |                  < 50 ms |          < 250 ms |                                           < 500 ms |
| Post-approval tool start without checkpoint |                  < 50 ms |          < 150 ms |                                           < 300 ms |
| Checkpoint-based approval                   |                  < 50 ms |               n/a |                        visible progress throughout |
| Exact plan approval                         |                  < 50 ms |               n/a | visible phase updates; no silent interval > 250 ms |

## Regression tests to add

1. `/status` calls `core.status()` exactly once.
2. Slash-command input does not trigger the generic input refresh.
3. `core.status()` calls closure readiness at most once.
4. Model/thinking changes perform no repository or task-provider subprocesses.
5. `/workflow` default performs no code-provider query.
6. Permission prompt appears before any checkpoint copy begins.
7. One-path authorization performs one repository observation, not multiple snapshots.
8. Tool execution is not delayed by an awaited footer refresh.
9. Exact approval uses bounded provider reads: one preparation inventory, one pre-apply revalidation, one convergence inventory.
10. Fake providers delayed by 100 ms do not block Pi's render loop and always display progress.
11. A second footer-refresh request coalesces without a second provider observation when the first result is current.
12. SQLite lock waits are reported rather than appearing as unexplained UI freezes.

## Lower-priority factors

- Markdown report rendering can add cost for a very large `/workflow full`, but it is not the main source of multi-second blank pauses.
- Synchronous SQLite writes add some latency, but the external-process fan-out and repeated snapshots are the dominant causes in normal operation.
- The code-intelligence index itself is not necessarily slow during `/status`; the expensive part is recomputing workspace freshness through another repository snapshot.

## Release recommendation

The next alpha should be performance-only. Do not add more UI or provider surface until:

- Git/Jujutsu observations are asynchronous.
- `/status` and `/workflow` use one request-scoped observation.
- permission prompts display immediate phase feedback.
- duplicate footer refreshes are removed.
- latency budgets are enforced by delayed-provider tests.
