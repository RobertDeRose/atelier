# Changelog

## 0.14.0-alpha.43 — 2026-08-03

- Replace the act-mode regression's scheduler-sensitive 250 ms `tool_result` threshold with a deterministic assertion that tool completion publishes no synchronous footer/status observation.
- Verify successful and failed execution evidence immediately after each corresponding tool result.
- Remove behavioral assertions from cleanup so a premature test failure cannot be masked by a later missing-evidence assertion.
- Retain the alpha.42 runtime, model-Bash lifecycle, phase feedback, and durable UI-evidence behavior unchanged.

## 0.14.0-alpha.42 — 2026-08-03

- Replace the model-facing Bash wrapper with a sequential policy-controlled tool that owns authorization consumption, streamed output updates, a final success result or thrown failure/interruption, and bounded lifecycle evidence.
- Allow the asynchronous process runner to finish after a parent exits and inherited stdout/stderr become idle, while retaining process-group timeout and cancellation escalation.
- Remove repository/footer observation from Pi's `tool_result` critical path; post-turn refresh now begins from `agent_settled` after Pi can finalize the tool row and clear its working indicator.
- Present an above-editor phase widget, status entry, and working label before `/plan`, `/status`, `/workflow`, permission evaluation, model Bash, and each expensive exact-approval phase; yield one event-loop turn before blocking I/O.
- Persist bounded diagnostic evidence for report cards, footer renders, phase transitions, model Bash output/completion, direct-shell denials, and agent settlement. Model Bash output is represented only by byte counts, truncation state, and SHA-256.
- Make guided acceptance objectively verify distinct status/workflow reports, footer transitions, visible plan/approval phases, model Bash streamed output and final completion, and the final idle agent state.

## 0.14.0-alpha.41 — 2026-08-02

- Return a complete Pi `BashResult` from denied `user_bash` events instead of the `tool_call`-only `{ block, reason }` shape. Rejected direct shell commands now render an explicit Atelier denial with exit status 126 and are never executed by Pi's fallback shell path.
- Add regressions proving rejected outside-workspace writes create no marker and rejected secret reads expose no command output.
- Make default `/workflow` a distinct ledger-focused report containing mode, workflow checkpoint, plan, task, execution, provider, closure, reviewed constraints, and next action; `/status` remains the workspace/repository snapshot.
- Model Pi's `user_bash` event/result contract in the local SDK declarations so a future `{ block, reason }` regression fails type checking.
- Make standalone guided and live harnesses activate the repository toolchain through `mise exec`; live resume also rejects mixed-version acceptance clones while archive/status remain available for old evidence.

## 0.14.0-alpha.40 — 2026-08-02

- Rebuild the release directly on the maintained `8c29808` branch supplied by the user, so the bundle is fast-forwardable from the actual local checkout.
- Replace the idle footer regression's fixed 500 ms polling window with an event-driven wait for the exact dirty/degraded footer render and a bounded diagnostic timeout.
- Synchronize the bundled guided and live acceptance harness identities with alpha.40.
- Supersede the divergent alpha.39 bundle; no runtime authorization or canonical-path semantics are changed.

## 0.14.0-alpha.38 — 2026-08-02

- Make the workflow-first denial regression assert the preserved caller path rather than comparing a canonical `/private/var/...` path to macOS's lexical `/var/...` spelling.
- Keep canonical `resolvedPath` authoritative for workspace enforcement while retaining `effect.path` for caller-facing audit correlation.
- Run the complete Pi-extension policy regression through the canonical temporary-path alias lane.

## 0.14.0-alpha.37 — 2026-08-02

- Record the concrete workspace-policy decision even when the workflow guard blocks a tool first.
- Keep headless denials auditable without prompting, checkpointing, or broadening workflow authority.
- Fix the resumed outside-workspace shell acceptance gate after a prior failed or paused execution.

## 0.14.0-alpha.36 — 2026-08-01

- Made headless shell-denial acceptance rely on durable workspace-policy evidence rather than Pi-version-specific JSONL wording.
- Added an explicit assertion that the Bash tool ended in error and that the outside-workspace marker was never created.
- Preserved restart-resume verification by archiving and reusing the exact policy-decision ledger evidence.

## 0.14.0-alpha.35 — 2026-08-01

- Replaced the non-portable `head -n -1` sourced-script test with an explicit `self-check` harness command.
- Guarded `scripts/live-acceptance.sh` entrypoint execution so its functions can be sourced safely by tests and diagnostics.
- Kept the canonical path identity implementation from alpha.34 unchanged and verified it through the dedicated alias-path release lane.

## 0.14.0-alpha.34 — 2026-08-01

### Fixed

- Correlate Pi `tool_execution_start` and `tool_execution_end` events before deciding whether a read error is expected.
- Treat `EISDIR` as benign only when the attempted read resolves inside the acceptance workspace; directory reads outside the workspace remain failures.
- Keep the expected `ENOENT` exception limited to the exact missing `tests/version.test.ts` path.
- Tell the implementation turn to read only the two reviewed files and never read `.` or another directory.
- Add an idempotent `resume implementation` checkpoint so a harness-only assertion failure does not repeat already-completed model edits.

### Tests

- Add a live-harness parser self-check covering an in-workspace directory read, the one expected missing file, and rejection of an out-of-workspace directory read.

## 0.14.0-alpha.33 — 2026-08-01

### Fixed

- Make codesearch indexing and client-mode tests assert the canonical repository root passed to provider subprocesses instead of the lexical temporary-directory alias.
- Make Jujutsu workspace-identity tests derive the expected identifier from the canonical workspace root.
- Make reviewed dependency-path tests assert the canonical filesystem entry used by task execution authority.
- Add a deterministic symlinked-`TMPDIR` test lane so Linux CI reproduces macOS `/var/...` versus `/private/var/...` path semantics.

### Tests

- Run canonical-path, codesearch, Jujutsu, task-constraint, and workspace-policy regressions through both the ordinary temporary directory and a filesystem alias.

## 0.14.0-alpha.32 — 2026-08-01

### Fixed

- Replace ad-hoc path resolution with one canonical identity layer shared by configuration, session workspaces, repository providers, workflow scope, permission evaluation, code providers, validation, multi-repository finalization, and recovery.
- Resolve relative repository paths against the repository root rather than `process.cwd()`, and canonicalize every existing ancestor before deriving Git or Jujutsu pathspecs.
- Preserve caller spellings for result lookup while mapping filesystem aliases such as macOS `/var/...` and `/private/var/...` to one repository identity.
- Preserve the final filesystem entry separately from its resolved target so tracked symlinks retain their VCS, workflow, fingerprint, and recovery identity.
- Restore exact Git index/worktree state for valid and broken symlinks without checkpointing the target file by mistake.
- Keep workspace confinement based on the fully resolved target, including missing descendants below escaping symlinks.
- Ignore normal `EPIPE`/`ECONNRESET` races when a short-lived subprocess exits before stdin finishes flushing.
- Run live and guided Pi acceptance with user extensions disabled while loading the Atelier extension explicitly, preventing unrelated local extension failures from invalidating Atelier acceptance.

### Tests

- Add alias-root, relative-path, missing-descendant, final-symlink, recovery, code-provider, Git, Jujutsu, workflow-policy, and complete `AtelierCore` canonical-path regressions.

## 0.14.0-alpha.31 — 2026-08-01

### Fixed

- Canonicalize Git and Jujutsu repository roots and requested pathspecs through existing ancestors before computing repository-relative paths. This prevents macOS `/var/...` versus `/private/var/...` aliases from being misreported as outside the worktree during status, permission, validation, retrieval, and execution-evidence operations.
- Preserve caller path keys while using canonical paths for VCS classification, so workspace policy and workflow authorization consume the exact batched result they requested.
- Version repository-observation caches and discard results that began before an invalidation, preventing a slower stale Git or Jujutsu observation from replacing newer footer, workflow, or intelligence state.
- Invalidate in-flight code-workspace observations together with repository state and prevent stale workspace completion from replacing a newer source baseline.
- Remove the deterministic process-runner test's 200 ms child-start assumption while retaining strict timeout, cancellation, partial-output, and force-termination assertions.

### Tests

- Add portable Git and Jujutsu symlink-alias regressions that reproduce the macOS canonical-path failure without requiring `/private/var` on the test host.
- Add a deterministic in-flight observation race proving invalidated results cannot overwrite fresh cached state.

## 0.14.0-alpha.30 — 2026-08-01

### Performance

- Reuse one request-scoped repository observation across status, workflow authorization, workspace policy, approval evidence, recovery preparation, and execution-evidence start.
- Move interactive Git and Jujutsu observations to the bounded asynchronous process runner so Pi can render and accept input while VCS commands execute.
- Make `/status` share one calculation with the footer, skip the generic input refresh for slash commands, and avoid recomputing the complete closure predicate during passive display.
- Make `/workflow` ledger/status-only by default; `/workflow full` and `/workflow refresh` explicitly request retrieval-backed reconstruction.
- Cache immutable repository identity, Beads version/initialization probes, recent task reads, and code-provider readiness; discard failed cache promises and invalidate caches at mutation boundaries.
- Hash only changed and untracked source paths for dirty-source identity, batch VCS path classification, and reuse workspace snapshots where the exact operation permits it.
- Prompt before copying an expensive recovery checkpoint, show visible analysis/checkpoint/reconciliation phases, and remove footer refresh from the approved tool-start critical path.
- Bound exact approval to preparation, one pre-apply inventory, and one convergence inventory instead of hidden repeated previews.
- Add `/performance` with bounded interactive, subprocess, hashing, cache, and SQLite timing diagnostics, including potential lock waits.

### Tests

- Add regressions for event-loop responsiveness, one-observation status, cache reuse, approval-before-checkpoint ordering, slash-command refresh ownership, and exact-approval inventory counts.

## 0.14.0-alpha.29 — 2026-08-01

### Fixed

- Replace the smoke-cancellation test's two-second polling assumption with bounded synchronization against either the blocking child marker or an early child-process exit.
- Capture bounded stdout, stderr, spawn errors, and exit metadata so a startup failure reports its cause rather than only `false !== true`.
- Always terminate and await the detached smoke process group from cleanup paths, preventing a failed readiness assertion from leaking the smoke shell or fake Node child.
- Retain exact assertions that success, explicit failure, and cancellation remove the temporary repository and external smoke state.

## 0.14.0-alpha.28 — 2026-07-31

### Fixed

- Refresh the custom Pi footer immediately from `thinking_level_select` and `model_select` instead of retaining runtime values captured when the repository Core opened.
- Serialize session-local footer observations so slower Git/Jujutsu, workflow, or code-provider reads cannot overwrite newer state.
- Refresh workflow and repository state after typed tools, direct user shell, interactive editor/navigation returns, validation, diff review, commits, task transitions, compaction, index lifecycle changes, and the next user interaction.
- Track the indexed source baseline and render intelligence as `degraded` when current workspace source revisions move beyond it; completed or provider-confirmed indexing restores `ready`.
- Mark provider failures `offline` and restore Pi's built-in footer when an authoritative repository/status observation fails rather than leaving stale Atelier state visible.
- Add deterministic regressions for immediate model/thinking refresh, direct-shell Git dirtiness and index freshness, idle external source drift, and corrected guided Step 1 instructions.

## 0.14.0-alpha.27 — 2026-07-31

### Fixed

- Treat post-approval retrieval/index drift as non-authoritative provenance when the reviewed source baseline, task mapping, and execution constraints remain exact.
- Record retrieval drift once per execution grant instead of invalidating an untouched approved task before implementation begins.
- Include the exact configured validation catalog, required flags, and path/symbol selectors in the model-facing planning instruction so generated plans do not invent `typecheck` or other unconfigured names.
- Rewrite guided Step 2 around the implemented investigate-mode and recoverability matrix, including explicit reject instructions only for secret, outside-workspace, and indeterminate effects.
- Restore every path-scoped Git or Jujutsu recovery checkpoint, print checkpoint IDs/providers/paths, and verify exact restored contents before recording the manual result.
- Make Step 4 validate the generated plan without manually repairing it, and make Step 5 spell out the exact paused typed-edit probe.
- Add regressions for approval → retrieval → implementation → pause → blocked edit → resume → cancellation and for multi-checkpoint guided restoration.

## 0.14.0-alpha.26 — 2026-07-31

- Emit `Buffer` chunks through Pi's `BashOperations` contract so output-producing direct `!` commands do not terminate the interactive host.
- Suspend and restore Pi's TUI around configured editors, `/atelier-open`, `/atelier-files`, and Yazi navigation.
- Preserve Pi stderr and exit status for each guided step and leave unexpected failures visible instead of immediately clearing the terminal.
- Add `guided-verification.sh retry STEP` to rebuild and rerun one disposable failed workspace while retaining earlier results.
- Extend the guided checks to verify editor round trips and continued Pi usability after direct shell output.

## 0.14.0-alpha.25 — 2026-07-31

### Fixed

- Rendered guided Markdown through quoted heredocs so backticks remain literal instead of executing slash commands and footer labels as shell command substitutions.
- Injected the dynamic outside-workspace path separately without exposing the rest of the guide to expansion.
- Refreshes all five guide files whenever `guided` starts, repairing existing alpha.24 runs without recreating workspaces or deleting recorded manual results.
- Added regression assertions for `/status`, `git:`, `intel: disabled`, direct-shell examples, protected-file examples, and the fully rendered outside-workspace command.

## 0.14.0-alpha.24 — 2026-07-31

### Fixed

- Corrected guided-workspace readiness detection so an empty `guided/` directory no longer suppresses automatic preparation.
- Automatically prepares all four guided repositories and five step guides when `guided` is run after live acceptance.
- Preserves recorded results when a previously started guided workspace becomes incomplete, requiring an explicit `prepare` reset instead of silently deleting evidence.
- Emits alternate-screen and terminal-mode reset sequences only after Pi actually launches, so startup errors remain visible in the terminal.
- Added regressions covering automatic preparation, complete step execution, evidence archiving, and visible pre-launch failures.

## 0.14.0-alpha.23 — 2026-07-31

### Fixed

- Corrected the guided-verification launcher so workspace-dependent local variables are initialized before use under `set -u`.
- Applied the same safe initialization pattern to guided evidence collection and recovery-checkpoint restoration.
- Added an executable regression that runs guided steps 3–5 with fake TUI/provider commands, records PASS results, collects evidence, restores checkpoint state, and creates the guided archive.

## 0.14.0-alpha.22 — 2026-07-31

### Fixed

- Replaced synchronous codesearch indexing with the bounded asynchronous process runner so timeout handling drains captured stdout and stderr before reporting failure.
- Preserved provider output written immediately before a timeout, including the final diagnostic line observed on macOS.
- Added `SIGTERM`-to-`SIGKILL` escalation for timed-out, idle, or aborted child process groups that refuse graceful termination.
- Added process-runner and codesearch regressions covering output preservation during timeout handling.

## 0.14.0-alpha.21 — 2026-07-30

### Fixed

- Avoided `codesearch index --force` for a fresh repository, including when the initial MCP startup creates an empty `.codesearch.db` before local indexing begins.
- Recovered an existing empty or partially initialized codesearch database through the normal incremental index path instead of repeating a forced rebuild.
- Reserved forced codesearch rebuilds for populated indexes whose corpus-selection fingerprint is missing or changed.
- Reported subprocess timeout, exit status, signal, stderr, and stdout together so partial provider output can no longer hide the actual indexing failure.
- Added live-acceptance diagnostics that preserve the Atelier error plus direct codesearch doctor and statistics output on index failure.

## 0.14.0-alpha.20 — 2026-07-30

### Fixed

- Made Atelier-created Git source and workflow-metadata commits explicitly unsigned so workstation `commit.gpgSign=true` and unavailable SSH/GPG agents cannot break reviewed task finalization.
- Preserved non-secret Git isolation controls in minimal subprocess environments, allowing deterministic test and controlled-launch configuration to reach repository-provider commands without exposing signing agents or credentials.
- Made the per-turn unsandboxed-approval regression platform-independent by explicitly selecting the `none` backend instead of assuming Seatbelt or Bubblewrap is unavailable.
- Added a provider-level regression that reproduces SSH-signing configuration with no agent and verifies the reviewed commit succeeds.

## 0.14.0-alpha.19 — 2026-07-30

### Security

- Rejected repository-owned editor and provider executable overrides before provider construction; executable commands now come only from user configuration, controlled defaults, or `ATLR_EDITOR`.
- Made the hardened shell classifier authoritative alongside Pi effect extraction so VCS mutations, command preprocessors, home-directory reads, and other parser disagreements cannot inherit repository-read authorization.
- Required one concrete approval for every Bash or direct-user shell command when Seatbelt or Bubblewrap is unavailable, and passed unsandboxed permission only to that approved invocation.
- Renamed the Bash surface from workspace-sandboxed to policy-controlled and exposed the lack of OS confinement in the approval text.

### Correctness

- Added workspace-wide source-content fingerprints for validation evidence and Working State so secondary-repository edits stale evidence while metadata-only commits do not.
- Added coordinated multi-repository commits, repository-labelled final diffs, closure checks, workflow-metadata finalization, and partial-failure evidence.
- Added end-to-end regressions for the authoritative shell path, malicious repository executable configuration, unsandboxed fallback approval, and complete two-repository task finalization.
- Moved smoke and CLI fixtures to user-owned executable configuration.

## 0.14.0-alpha.18 — 2026-07-30

- Added expandable, visually separated report cards with horizontal dividers and `➤`/`▼` headers driven by Pi's persistent-entry expansion state.
- Replaced sparse status and code-provider tables with concise bold field/value lines while retaining tables for dense task collections and grouped sections for code results.
- Added `/workflow` as the canonical durable workflow report and retained `/state` as a compatibility alias; `/workflow full` exposes the complete diagnostic Working State.
- Reduced the default workflow report to actionable task, execution, validation, retrieval, and diagnostic summaries instead of the complete raw Working State.
- Added concise per-report summaries for status, workflow, code search, symbols, changed paths, validation, evidence, and ready tasks.

## 0.14.0-alpha.17 — 2026-07-30

### Fixed

- Built Pi Markdown themes from the initialized theme supplied to each entry-renderer callback instead of calling the coding-agent global theme singleton.
- Removed the deterministic and runtime dependency on `getMarkdownTheme()`, eliminating `Theme not initialized` failures outside a fully initialized Pi TUI.
- Retained host resolution only for Pi's `Markdown` component and added a regression proving persistent reports consume Markdown markers with an uninitialized test-global theme.

## 0.14.0-alpha.16 — 2026-07-30

- Resolve Pi Markdown runtime from mise/global npm wrapper layouts under `lib/node_modules`.
- Match regular wrapper scripts as well as symlinked Pi executables.
- Add a live-layout regression reproducing the installed mise package structure.

## 0.14.0-alpha.15 — 2026-07-30

### Fixed

- Resolved Pi's Markdown renderer from the launched Pi host instead of Atelier's project-local module path.
- Removed the module-load TTY gate that permanently selected the raw-text fallback before interactive rendering began.
- Declared Pi TUI as an optional peer dependency alongside the Pi coding-agent host.
- Added an explicit visible diagnostic when Markdown rendering cannot be loaded instead of silently displaying raw Markdown.
- Added runtime resolution and component-construction regressions for persistent report entries.

## 0.14.0-alpha.14 — 2026-07-30

### Changed

- Replaced transient `/status`, `/state`, code-intelligence, changed-path, validation, evidence, and ready-work notifications with persistent TUI-only Markdown report entries.
- Added Markdown tables for compact status surfaces and grouped definitions, references, source, tests, documentation, and generated code in retrieval reports.
- Added a neutral `intel: disabled` state for workspaces with no configured code provider; `offline` now means a configured provider is unavailable.
- Kept footer thinking levels at normal text contrast instead of the theme's dim color.
- Added an in-tree guided verification harness that clears each terminal transition, identifies the intentional VCS/provider state, keeps detailed instructions outside the Pi viewport, and archives CLI/VCS/ledger evidence.
- Made the live-acceptance implementation and validation phases deterministic around expected missing future files, focused validation, and stale-evidence edits.

## 0.14.0-alpha.13 — 2026-07-30

### Changed

- Replaced the dense single-line Pi footer with a two-line, left/right-aligned Atelier footer.
- Added bold semantic headings and theme-aware success, warning, error, accent, and dim state colors.
- Added adaptive task presentation: human-readable task titles at wide widths, truncated titles at medium widths, and Beads IDs on narrow terminals.
- Added provider-native Git branch and Jujutsu bookmark/change identity plus explicit clean, dirty, conflicted, and unknown VCS state.
- Added explicit code-intelligence states: ready, indexing, degraded, and offline.
- Removed duplicate VCS and workflow details plus expected empty-state noise from the footer.

## 0.14.0-alpha.12 — 2026-07-30

### Fixed

- Canonicalized typed Pi read, write, and edit paths before workflow evaluation so macOS `/var`
  aliases match Atelier's `/private/var` session workspace and designated plan path.
- Made designated plan writes compare effective access paths rather than lexical path strings.
- Canonicalized Git repository roots and recovery targets through existing ancestors, preserving ignored
  files and broken symlinks reached through macOS path aliases.
- Corrected workspace-policy regressions to assert canonical session identities and canonical VCS path-state keys across platforms.

## 0.14.0-alpha.11 — 2026-07-29

### Changed

- Removed the legacy policy engine, permission grants, permission profiles, remembered approvals, active permission table, and filesystem capability bundle.
- Retained reviewed plan execution metadata only as workflow and task constraints.
- Made the canonical startup directory, or explicit `--workspace`, the immutable session workspace.
- Added quote-aware structured and shell effect analysis with concrete consequence prompts.
- Routed Pi model Bash and direct `user_bash` through one pre-execution workspace-policy path and one sandbox-aware executor.
- Added exact verified Git recovery for staged, unstaged, partially staged, rename, mode, symlink, ignored, and untracked state.
- Added native Jujutsu operation checkpoints and restoration verification.
- Associated every automatic checkpoint with its initiating tool call and Pi session, exposed a restore command, and removed partial checkpoints on failure.
- Removed remaining validation and code-workspace trust switches and deleted legacy permission storage during ledger migration.
- Expanded policy and acceptance coverage for workspace overrides, `chdir` immutability, secret paths, symlink escape, failed checkpoints, and unauthorized shell execution.

## 0.14.0-alpha.10 — 2026-07-29

### Changed

- Replaced Atelier project trust and granular permissions with an immutable startup-workspace and recoverability policy.
- Added VCS-aware recovery checkpoints, consequence-based approvals, and structured-tool and shell effect interception.
- Isolated subprocess environments, redacted retained evidence, and added inspect, export, prune, and delete lifecycle commands.
- Added cancellable asynchronous provider execution and Beads v2 JSON-envelope compatibility.
- Added configurable footer ownership and one typed status model across CLI, Pi, footer, and Working State.
- Added Seatbelt/Bubblewrap-backed workspace-confined shell execution when a supported backend is available.
- Added cancelled-task resumption, dedicated approval surfaces, definition-first retrieval presentation, and explicit multi-repository workspace scopes.
- Added repository navigation, editor open-at-line, project-tree, and scrollable exact-diff surfaces.
- Added canonical plan-scope editing and authoritative per-turn context capsules independent of compaction.
- Added a local serialized Atelier Core service with status, state, workspace, and code-intelligence RPC methods.

## 0.14.0-alpha.9 — 2026-07-29

- keep exact plan approval as an approval-only transaction; accepting `/approve` no longer injects a user message or starts implementation automatically
- display the complete task reconciliation and capability scope persistently before the approval confirmation
- distinguish missing, unapproved, and approved plans in Pi and CLI status output
- expose the active execution grant and repository identity in `/status` and `atlr status`
- render no-task closure as not applicable rather than blocked
- replace Pi's Git-only detached footer in TUI sessions with an Atelier VCS-aware footer that identifies Jujutsu changes or Git commits
- add regressions for idle approval, capability visibility, plan-state correctness, execution-grant visibility, and VCS presentation

## 0.14.0-alpha.8 — 2026-07-29

- Split source cleanliness from whole-repository cleanliness and retain `requireCleanGit` as a legacy alias.
- Finalize workflow and task-provider metadata in a separate local change before recording successful task closure.
- Allow typed reads of nonexistent in-root targets while preserving symlink-escape rejection.
- Derive next actions from structured closure blocker codes and report completed workflows as completed rather than blocked.
- Include provider/workflow metadata mutations in typed task-close execution evidence.
- Add an in-tree live-acceptance harness that rejects unexpected Pi tool errors, forced continuation, incomplete symbol resolution, and dirty post-close repositories.

## 0.14.0-alpha.7 — 2026-07-28

- preserve canonical repository-root behavior for exact task capability paths on macOS
- compare the narrow-capability regression against Atelier's canonical configured root instead of the
  noncanonical `/var` temporary-directory alias
- leave production authorization behavior unchanged; this release corrects only the platform-dependent
  alpha.6 test expectation

## 0.14.0-alpha.6 — 2026-07-28

- replace the Pi `agent_settled` follow-up completion loop with one passive, deduplicated incomplete-task
  notification so denial, Escape, and normal settlement leave the user in control
- make `/cancel` revoke active execution without waiting for idle and abort the active Pi turn after the
  durable grant is revoked
- add the model-facing typed `atlr_validate` tool for validation planning, focused execution, and named
  declared checks; generic Bash is no longer the only model route to validation
- classify tool interruption from structured abort state or an exact tool-owned abort sentinel rather
  than arbitrary error output containing words such as `signal` or `AbortSignal`
- distinguish missing focused selection, no required path match, and missing required validation in task
  closure diagnostics
- make explicit CLI and `/code-symbols` requests direct human lookups while retaining inventory-first
  gating for autonomous model calls
- normalize provider symbol signatures, discard generic chunk labels, rank exact definitions first,
  reconcile cached symbol state, and preserve workspace/repository scope qualification
- reject malformed expression-shaped exact-symbol hints produced from plan text
- harden existing and new `.beads` directories to mode 0700 on non-Windows systems
- request the smallest independently deliverable plan graph, keep tiny implementation/tests atomic, and
  make code-provider status/search output more concise
- replace the prior disposable acceptance walkthrough with a reboot-safe persistent workflow and correct
  the trust-store snapshot command that could truncate its own input
- require a structured per-task execution contract and derive file, dependency, validation, local-change,
  and closure capabilities only from its reviewed paths and flags
- disclose every effective task capability and exclusion in the approval transaction; task update/link,
  full-suite validation, dependency changes, and generic shell are no longer implicit
- add typed `atlr_state`, `atlr_commit`, and `atlr_task_close` model tools alongside `atlr_validate`, and
  enforce explicit per-turn prohibitions before any exceptional approval prompt
- add `/atelier-stop`, `/atelier-pause`, and `/atelier-resume`; make pause and cancellation durable,
  atomic workflow transitions while preserving the provider task and working-copy changes
- make execution restoration idempotent so repeated agent lifecycle events do not fabricate resume events
- attribute mutation evidence to the paths changed by each individual tool operation rather than every
  path already dirty in the repository
- split raw VCS identity from source-only revision binding so `.atelier`, Beads, and provider-metadata
  churn does not invalidate source evidence
- scope Git and Jujutsu task commits to the reviewed execution paths so workflow metadata and unrelated
  staged changes cannot be swept into the implementation change
- make `atlr init --beads` idempotent for an initialized provider and preserve existing Beads files
- allow direct reads for exact known paths instead of requiring ritual semantic discovery

## 0.14.0-alpha.5 — 2026-07-28

- isolate the deterministic test process from workstation and system Git configuration so user-level
  SSH/GPG commit signing, hooks, credential prompts, and pagers cannot alter fixture behavior
- explicitly disable signing for temporary and live-conformance repository commits
- add regressions that verify the suite preloader is active and prove temporary repositories succeed
  even when an injected global Git configuration requires a failing signer
- bound deterministic test-file concurrency at eight and raise fake Octocode process deadlines from two
  to ten seconds so aggregate process contention does not turn successful provider fixtures into startup
  or stats timeouts
- preserve Octocode version-probe timeout diagnostics instead of misreporting a timed-out executable as
  missing

## 0.14.0-alpha.4 — 2026-07-28

- compare `/atelier-trust` notifications with Atelier's canonical trust identity instead of a
  noncanonical temporary-directory alias
- add a platform-independent repository-symlink regression so Linux CI exercises the same identity
  behavior as macOS `/var` to `/private/var` resolution
- preserve the production trust behavior; this release corrects the alpha.3 test expectation that failed on macOS

## 0.14.0-alpha.3 — 2026-07-27

- rename Atelier's Pi trust command from `/trust` to `/atelier-trust` so it no longer collides with Pi's built-in project-trust command
- preserve `atlr trust ...` for CLI trust management and document the distinct Pi and Atelier trust boundaries
- add a regression assertion that the extension never registers Pi's reserved `/trust` command

## 0.14.0-alpha.2 — 2026-07-27

```text
fix(test): canonicalize plan-review path expectations

- preserve real-path canonicalization for trusted repository and plan paths
- assert ManualEdit changed paths against Atelier's canonical configured plan path
- add a repository-alias regression covering macOS /var to /private/var behavior
- run deterministic CI on Ubuntu 24.04 and macOS 26
```

## 0.14.0-alpha.1 — 2026-07-27

```text
fix(safety): make reviewed execution truthful and fail closed

- require external project trust before repository-controlled commands can start
- move runtime state outside the repository and make doctor observational
- treat generic shell as unconfined, single-operation approval only
- add symlink-safe typed path confinement and an adversarial command corpus
- bind exact approval to source, every workspace root, retrieval revisions, and typed task operations
- atomically install task constraints while excluding arbitrary shell execution
- enforce required validation, exact final-diff review, a local change, and clean closure state
- make Git/Jujutsu observation failure explicit and include staged/untracked Git evidence
- isolate Pi sessions and await asynchronous provider shutdown
- emit stable JavaScript/declarations, unify release metadata, and add deterministic/live CI gates
- correct ADR identifiers and document all 29 review recommendations
```

## 0.13.0 — 2026-07-27

```text
feat(workflow): prove exact local execution end to end

- open initial plan drafts in the configured foreground editor and persist ManualEdit diffs
- require exact plan hash, provider reconciliation digest, and explicit approval before mutation
- reconcile create, adopt, update, dependency link/unlink, and retirement idempotently
- bind act mode to one approved-plan task/workspace without implying action permissions
- persist post-tool success, failure, interruption, snapshots, and observed changed paths
- select focused validation with reasons and reject stale passes at task closure
- reconstruct approval, task, grants, mutation evidence, validation, and next action after restart
- add explicit execute and cancel flows to both CLI and Pi
- add portable end-to-end and smoke-cleanup acceptance without live optional services
- document authority boundaries, migration preservation, and the disposable Jujutsu launch gate
```

## 0.12.0 — 2026-07-27

```text
feat(retrieval): bound and prove self-hosting evidence reuse

- enforce one semantic discovery before unresolved exact-symbol lookup
- reuse equivalent canonical queries and known paths without provider dispatch
- isolate repository scopes and invalidate overlapping repository/index bindings
- preserve historical provenance without reporting invalid evidence as current
- report calls, cache hits, overlap reuse, unique paths, deduplication, bytes,
  truncation, invalidations, and repository scopes
- gate codesearch evaluation against every accepted expected path and recall score
- add a portable eight-call self-hosting scenario and provider-independent acceptance
- verify the supported launch flow with one provider call and one exact cache hit
```

## 0.11.0 — 2026-07-26

```text
feat(workflow): make approved local execution usable

- persist restart-safe workflow and ManualEdit lifecycle records
- add deterministic structural plan snapshots and diffs
- migrate the ledger atomically to workflow schema version 2
- default routine approved-task work inside the active repository to allowed
- distinguish routine, destructive, external, and unknown command effects
- retain approval for destructive commands, publication, external effects,
  unknown commands, and explicit paths outside the repository
- classify mise validation, local runtimes, Git commits, and normal Jujutsu
  operations as routine execution
- add an act-mode completion guard for validated but uncommitted task work
- add focused policy, classifier, Pi, review, migration, and recovery tests
```

## 0.10.7 — 2026-07-26

```text
fix(plan): start slash-command planning immediately

- remove the unresolved waitForIdle boundary from /plan
- rely on Pi's command boundary before sending the planning message
- preserve objectives supplied as /plan <context>
- add a regression with a deliberately unresolved idle promise
```

## 0.10.6 — 2026-07-26

```text
fix(code): coordinate background indexing in Pi

- start code indexing in the background when a Pi session launches
- coalesce startup, command, and concurrent index requests into one operation
- make searches, symbol lookup, and relationships wait for active indexing
- prevent status checks from reconnecting MCP while the local writer is active
- show building, ready, and failed index state in the Pi footer
- route /code-index through the same lifecycle
- record completed and failed indexing outcomes in the ledger
- add focused concurrency and waiting regressions
```

## 0.10.5 — 2026-07-25

```text
fix(plan): activate provider tools for agent turns

- explicitly add Atelier code tools to Pi's active tool set
- prioritize code search and symbol lookup before generic Bash/read tools
- converge activation on session start, plan entry, and every agent turn
- name the active tools directly in the plan instruction
- retain approval-free exact reads and read-only shell commands
- block the exact broad find/rg commands observed in the live demo session
- add active-tool and live-command regressions
```

## 0.10.4 — 2026-07-25

```text
fix(plan): allow reads and enforce provider-first discovery

- classify compound shell commands segment by segment
- allow read-only pipelines, command chains, and safe /dev/null sinks without approval
- preserve mutation gates for redirection, find write actions, and nested mutating execution
- expose Atelier code status, search, and symbol lookup as agent-callable Pi tools
- require provider-first repository discovery in plan mode
- allow raw grep/find/rg/ls fallback only after unavailable, degraded, failed, or empty provider evidence
- add regressions derived from the failing live planning session
```

## 0.10.3 — 2026-07-25

```text
fix(shell): normalize Bun SQLite missing rows

- normalize bun:sqlite Statement.get() null results to undefined
- preserve node:sqlite missing-row behavior
- make ledger state and task-mapping reads null-safe
- keep the existing database schema and persisted state unchanged
- add a Bun missing-row regression at the runtime boundary
- retain dual-runtime and launcher regressions
```

## 0.10.2 — 2026-07-25

```text
fix(shell): support Pi's Bun SQLite runtime

- detect the actual Bun extension runtime used by Pi
- select bun:sqlite in Bun and node:sqlite in Node
- preserve the existing SQLite schema and synchronous ledger API
- avoid static SQLite built-in imports in the Pi dependency graph
- canonicalize repository roots before launch on macOS
- add Bun selection, Node fallback, and canonical launcher regressions
- supersede the Node-only runtime assumption in ADR-0014
```

## 0.10.1 — 2026-07-25

```text
fix(shell): make the Pi extension launchable

- replace static node:sqlite imports with runtime built-in resolution
- preserve the existing SQLite ledger and database format
- add an actionable runtime compatibility error
- add atlr launch and mise run launch as supported Pi entry points
- forward Pi arguments unchanged from the Atelier launcher
- add SQLite-loader and launcher regression tests
```

## 0.10.0 — 2026-07-23

```text
feat(state): integrate retrieval into task-backed Working State

- persist the planning objective as durable Atelier state
- retrieve code evidence during planning before a provider task exists
- add a deterministic repository-state planner with bounded exact identifier hints
- scope ready-task selection to the approved plan and record selection rationale
- reconstruct direct dependencies, blockers, corrections, findings, and Manual Edits
- preserve durable current-task state across transient provider failures
- record retrieval queries, degradation, warnings, and result counts in Working State
- commit the missing Octocode 0.14.0 mise lock entry
```

## 0.9.8 — 2026-07-23

```text
docs(code): decide the Octocode provider role

- preserve the complete baseline/codesearch/Octocode comparison fixture
- accept codesearch as the continuing default retrieval provider
- reject Octocode for default semantic repository retrieval
- retain Octocode for explicit signatures, structural search, and GraphRAG experiments
- record the provider decision and structural promotion gate in ADR-0021
- stop the Octocode ranking-repair loop without new workflow evidence
```

## 0.9.7

```text
feat(code): compare Octocode with accepted retrieval paths

- preserve the fully conforming Octocode 0.14.0 live run
- generalize evaluation across baseline, codesearch, and Octocode
- retain provider-native and final ranking evidence per result
- refresh both indexes before comparative live evaluation
- report incomplete comparisons as failures and weak quality as warnings
- add dedicated Octocode and all-provider evaluation tasks
```

## 0.9.6

```text
fix(code): normalize Octocode text MCP responses

- parse semantic search text into normalized repository hits
- retry symbol lookup with signature detail and a zero similarity threshold
- parse signature and GraphRAG text into provider-neutral evidence
- call GraphRAG with the advertised operation schema
- preserve the successful local FastEmbed run as a regression fixture
```

## 0.9.5 — 2026-07-23

```text
fix(code): use the supported Octocode index lifecycle

- remove the unsupported Octocode index --force argument
- write and verify the project-local FastEmbed configuration directly
- preserve unmanaged project-local Octocode configuration
- retry zero-block indexes through the documented bare index command
- capture the failed force-based live run as a portable regression fixture
```

## 0.9.4 — 2026-07-23

```text
fix(code): configure project-local Octocode embeddings

- create an isolated Atelier Octocode configuration under .atelier
- use local FastEmbed code and text models without cloud API keys
- enable non-LLM GraphRAG for structural relationships
- pass OCTOCODE_CONFIG_PATH to every Octocode subprocess
- force the first rebuild when an existing index contains no blocks
```

## 0.9.3

```text
fix(code): harden Octocode embedding preflight and live collection

- clamp semantic search requests to the provider-advertised maximum
- reject missing cloud embedding credentials before long indexing runs
- verify indexing produced searchable blocks before reporting ready
- preserve MCP tool discovery when individual tool calls fail
- capture configuration, model support, and redacted key presence
- treat absent GraphRAG as a capability warning
- preserve the verified Octocode 0.14.0 MCP schema as a regression fixture
```

## 0.9.2

```text
fix(code): align Octocode adapter with live MCP contract

- fix collector positional argument ordering
- call semantic search, signatures, and structural tools directly
- gate GraphRAG relationships on advertised capabilities
- send query arrays and the documented max_results/detail_level fields
- map source and documentation focus to Octocode content modes
- allow long-running first-time Octocode indexing
- ignore generated Octocode indexes and probe artifacts
- preserve the verified Octocode 0.14.0 MCP contract as a regression fixture
```

## 0.9.1

```text
fix(code): provision and stabilize Octocode development integration

- install Octocode 0.14.0 through the mise development manifest
- compare canonical repository paths in multi-repository process tests
- diagnose a missing Octocode executable before invoking probe commands
- document platform-specific embedding-provider configuration
```

## 0.9.0 — 2026-07-22

```text
feat(code): add experimental Octocode provider

- accept codesearch as the default after matching baseline recall with better ranking
- add an Octocode MCP adapter behind the existing Code provider contract
- route multi-repository workspaces through one Octocode process per repository
- discover semantic, signature, graph, and structural capabilities at runtime
- add safe direct source fetching for local Octocode references
- add live Octocode MCP and indexing collection scripts
- correct the normalization benchmark to measure direct implementation evidence
```

## 0.8.9 — 2026-07-22

```text
fix(code): constrain lexical fusion to exact identifiers

- accept explicit exact identifier hints through the provider-neutral query model and CLI
- stop augmenting healthy semantic retrieval with generic workflow nouns
- retain broad literal term extraction only for degraded semantic fallback
- infer mixed implementation-and-test focus for questions requesting both evidence classes
- interleave source and test paths while preserving provider order within each class
- pass benchmark literals as exact provider hints and record hint usage in evaluation
- commit the 0.8571 weighted-recall fusion run as a portable pre-hint regression fixture
```

## 0.8.8 — 2026-07-22

```text
feat(code): fuse semantic and literal focused retrieval

- augment focused automatic and hybrid searches with bounded literal provider queries
- derive deterministic candidates from code-shaped identifiers and workflow terms
- merge semantic and lexical results with weighted reciprocal-rank fusion
- preserve provider rank while assigning Atelier orchestration rank separately
- record semantic, lexical, or combined retrieval methods on every result
- leave explicit semantic, explicit lexical, documentation, and neutral searches unchanged
- add fused-result metrics to comparative evaluation and live conformance
- commit the 0.5625 weighted-recall run as a portable pre-fusion regression fixture
```

## 0.8.7 — 2026-07-22

```text
feat(code): focus provider retrieval on workflow evidence

- add automatic and explicit source, tests, docs, and all search focus
- overfetch a bounded compact provider candidate pool before final truncation
- preserve provider rank and score through Atelier post-processing
- prioritize workflow-relevant path classes while retaining provider order within each class
- diversify files before returning duplicate chunks from the same path
- apply the same focus policy to the ripgrep evaluation baseline
- record provider order, resolved focus, and reranking in evaluation reports
- warn in live conformance when implementation focus or weighted recall remains weak
- commit the clean 2,138-chunk codesearch corpus as a portable regression fixture
```

## 0.8.6 — 2026-07-22

```text
fix(code): exclude captured evidence from repository retrieval

- add a repository-local codesearch corpus-selection manifest
- exclude real-provider response fixtures and generated knowledge archives
- fingerprint ignore inputs and provider version for local index selection
- force one rebuild when the selected corpus changes
- retain incremental indexing while the selection fingerprint is unchanged
- make the ripgrep baseline consume the same codesearch ignore file
- fail live conformance when ignored fixture paths leak into results
- compact captured evaluation fixtures by removing raw stdout and stderr payloads
- commit the successful vector-repair run as a portable regression fixture
```

## 0.8.5 — 2026-07-21

```text
fix(code): release MCP writer before local indexing

- stop and await the self-contained MCP subprocess before local repair
- prevent Tantivy LockBusy failures caused by competing Atelier-owned processes
- reconnect to MCP only after codesearch stats confirms HNSW readiness
- wait for graceful provider exit with a bounded SIGKILL fallback
- retain serve-backed client registration without disrupting the remote service
- commit the fourth real-provider archive as a portable writer-lock fixture
- add a regression that fails whenever indexing starts while MCP holds the writer
```

## 0.8.4 — 2026-07-21

```text
fix(code): repair and verify local vector indexes

- use the bare codesearch index command for local repair and incremental updates
- retain index add only for serve-backed client registration
- verify local HNSW readiness through codesearch statistics
- reject false-ready indexes that contain chunks without a built vector index
- capture vector statistics and store metadata before and after indexing
- require a built vector index in live conformance results
- commit the third real-provider archive as a portable regression fixture
- preserve lexical degradation as a fallback rather than an indexing substitute
```

## 0.8.3 — 2026-07-21

```text
fix(code): preserve retrieval across semantic provider failures

- detect error-bearing MCP text even when providers omit isError
- surface explicit semantic failures instead of returning empty results
- fall back from automatic and hybrid searches to bounded literal retrieval
- mark fallback evidence and provider status as degraded with warnings
- add explicit code-search mode selection to the CLI
- separately probe semantic, hybrid, literal, and automatic search health
- capture codesearch doctor, statistics, direct search, and store metadata
- commit the real vector-store failure as a portable regression fixture
- record degraded results and provider warnings in evaluation reports
```

## 0.8.2 — 2026-07-21

```text
fix(code): preserve failed provider collections

- complete fixture normalization and archive creation after conformance failures
- report the conformance summary and retained nonzero provider status
- treat unavailable optional impact indexing as a warning
- accept structured MCP content when validating fetch and outline responses
- add regressions for failed collection and optional provider capabilities
```

## 0.8.1 — 2026-07-21

```text
fix(code): isolate live providers and strengthen retrieval evaluation

- prevent ordinary tests from launching the real codesearch provider
- add an explicit live codesearch test task
- fail empty fixture imports with actionable guidance
- normalize local provider paths to repository-relative paths
- commit the complete verified codesearch 1.1.30 response fixtures
- separate cold-start latency from steady-state evaluation
- report ranked paths, weighted recall, reciprocal rank, and nDCG
- replace rigid benchmark prompts with weighted retrieval rubrics
- expand conformance checks for fetch, outline, and impact responses
- publish the first evidence-based codesearch evaluation report
```

## 0.8.0 — 2026-07-21

```text
feat(code): complete codesearch conformance and evaluation tooling

- qualify code evidence with indexed and current repository identities
- mark provider evidence stale after working-copy changes
- support optional codesearch impact and outline capabilities
- capture fetch, outline, impact, and MCP schemas in the live probe
- normalize real-provider output into portable test fixtures
- compare baseline ripgrep retrieval with codesearch retrieval
- add a single machine-side knowledge collection workflow
```

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
