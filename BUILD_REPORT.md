# Build Report — Atelier 0.14.0-alpha.32

## Result

Atelier builds successfully as stable JavaScript and declarations. The supported launcher consumes
`dist` rather than TypeScript source.

Delivered entry points:

```text
dist/packages/core/src/index.js
dist/packages/core/src/index.d.ts
dist/apps/cli/src/main.js
dist/apps/pi-extension/src/index.js
```

The package exports Core JavaScript/types, declares the built Pi extension, and retains `bin/atlr.mjs`
as the CLI entry. `prepack` rebuilds the package; source execution is development-only.

## Alpha.32 end-to-end canonical path identity

Alpha.32 completes the canonical-path correction across every repository-aware boundary instead of limiting it
to Git/Jujutsu observation calls:

- `path-boundary.ts` now distinguishes lexical spelling, canonical filesystem entry, and fully resolved access target;
- `repository-path.ts` is the only pathspec derivation layer for Git, Jujutsu, directory, validation, workflow, code-provider, and recovery callers;
- relative inputs use explicit repository/workspace bases and never inherit the process working directory;
- reviewed task scope and VCS/recovery operations preserve a final symlink entry while workspace containment follows its target;
- code workspace roots and provider results use canonical repository identity across aliases;
- exact recovery preserves valid and broken symlink entries, staged/unstaged state, modes, renames, ignored files, and untracked files; and
- the process runner handles early stdin pipe closure without converting a normal child exit into an uncaught `EPIPE`.

The guided and live acceptance scripts also launch Pi with user extensions disabled while explicitly loading
Atelier, isolating the product acceptance result from unrelated workstation extensions.

## Alpha.31 canonical-path and observation-invalidation correction

Alpha.31 corrects the supported macOS aggregate failures exposed after the alpha.30 observation-pipeline
release without reverting its latency improvements:

- Git and Jujutsu canonicalize provider roots and every requested path through existing ancestors before
  computing VCS-relative pathspecs, so macOS `/var/...` and `/private/var/...` identify the same worktree;
- path-state results retain the caller's absolute key while Git/Jujutsu execute only canonical in-repository
  pathspecs, preserving exact workspace-policy lookups;
- repository observation caches carry an invalidation generation, and a result started before invalidation can
  no longer replace newer footer, workflow, or intelligence state;
- in-flight code-workspace observations are detached on repository invalidation and cannot restore a stale
  source digest after an external edit; and
- the asynchronous process-runner regression no longer assumes a Node child can start and emit output within
  200 ms under aggregate scheduler pressure.

Portable regressions reproduce the path-alias defect through a directory symlink and deterministically hold an
old observation open across invalidation to prove that it cannot overwrite fresh state.

## Alpha.30 interactive-latency correction

Alpha.30 implements the complete twenty-item correction from the alpha.29 UI-latency audit without weakening
the workspace, recovery, exact-approval, or closure boundaries:

- `/status` owns one observation and shares it with the footer; slash-command input no longer schedules a competing refresh;
- passive status consumes cached closure evidence instead of running the complete closure predicate repeatedly;
- default `/workflow` is ledger/status-only, while `/workflow full` and `/workflow refresh` explicitly rebuild retrieval-backed Working State;
- model and thinking-level changes update runtime footer fields without repository, Beads, closure, or code-provider I/O;
- Git and Jujutsu interactive observations use the bounded asynchronous process runner with cancellation and startup/idle/total timeouts;
- request-scoped observations carry repository identity, display state, changed paths, batched path classifications, optional inventory, subprocess counts, and hashing metrics;
- repository roots, provider selection, Beads version/initialization state, recent task reads, and code-provider readiness are cached and invalidated at mutation boundaries;
- dirty-source identity hashes only changed and untracked source paths rather than the entire tracked source tree;
- permission evaluation reuses one observation, prompts before expensive checkpoint copying, and never waits for a footer refresh before an approved tool starts;
- exact approval uses preparation, one pre-apply revalidation inventory, and one post-apply convergence inventory;
- immediate working phases make repository observation, effect evaluation, checkpointing, reconciliation, convergence, and activation visible; and
- `/performance` reports bounded interactive, subprocess, hashing, cache, and SQLite timing samples, including potential lock waits.

New deterministic regressions verify event-loop responsiveness, one-observation status, short-lived observation
reuse, slash-command refresh ownership, prompt-before-checkpoint ordering, and exact-approval provider inventory
counts. ADR-0036 records the request-scoped observation contract.

## Alpha.29 deterministic smoke-cleanup synchronization correction

Alpha.29 corrects the supported macOS aggregate-test failure exposed after the alpha.28 footer work:

- the cancellation fixture waits for the blocking child or an early process exit for up to a bounded 60 seconds instead of assuming startup completes within two seconds under eight-way integration-test load;
- child stdout, stderr, spawn errors, and exit state are captured and included when the cancellation point is not reached;
- the detached smoke process group is force-terminated from `finally` on every assertion path, preventing a failed readiness assertion from leaking a shell and its sleeping child; and
- normal success, explicit command failure, graceful cancellation, temporary-directory cleanup, and logged repository removal remain independently asserted.

The correction changes only deterministic-test synchronization and diagnostics. It does not relax the smoke workflow or production cleanup behavior.

## Alpha.28 live-footer status correction

Alpha.28 audits every field in Atelier's custom Pi footer and moves live status ownership into a dedicated
session-local controller:

- model and thinking level update from Pi selection events without requiring another Atelier command;
- workflow/task/closure and Git/Jujutsu observations refresh after all structured mutations, direct user shell,
  interactive child return, validation, commits, closure, and the next user input;
- code-provider health and index lifecycle are tracked separately from source freshness; source revision drift
  changes `ready` to `degraded` until a current index completes;
- refresh requests are coalesced and serialized so an older slow observation cannot replace newer state; and
- failed authoritative observation releases the custom footer rather than preserving stale values.

Three new integration regressions cover runtime model/thinking selection, direct-shell VCS/index refresh, and
source changes made outside Pi while it is idle. Guided Step 1 now explicitly verifies immediate thinking-level
refresh.

## Alpha.27 guided-policy and execution-continuity correction

Alpha.27 aligns guided verification with the implemented workspace-recoverability policy and prevents
ordinary post-approval retrieval activity from revoking untouched execution authority:

- post-approval retrieval and index drift is recorded as provenance rather than treated as execution
  authority when the reviewed source, task mapping, provider, and task constraints remain exact;
- the model-facing planning instruction includes the exact configured validation catalog, required flags,
  and path/symbol selectors, preventing invented validation names such as `typecheck`;
- guided Step 2 now distinguishes investigate-mode typed-write denial from recoverable shell mutations and
  gives explicit approve/reject expectations for each operation;
- guided recovery prints every checkpoint ID, provider, and path, restores every path-scoped checkpoint,
  and verifies the exact restored contents before accepting the result;
- guided Step 4 treats incorrect generated execution metadata as a planner failure instead of asking the
  tester to repair it manually;
- guided Step 5 provides the exact typed-edit prompt used to prove pause enforcement; and
- executable regressions cover approval → retrieval → implementation → pause → denied edit → resume →
  cancellation and complete multi-checkpoint restoration.

## Alpha.25 guided-guide rendering correction

Alpha.25 corrects the generated Step 2 Markdown guide:

- all Markdown backticks are emitted from quoted heredocs and are never interpreted as shell command substitution;
- the dynamic outside-workspace path is injected through one isolated `printf` call;
- starting `guided` rewrites guide files in place, preserving prepared repositories and recorded results; and
- guided regressions verify the rendered slash command, footer labels, direct-shell commands, protected operations, and absolute outside-workspace path.

## Alpha.23 guided-verification initialization correction

Alpha.23 corrects the manual TUI walkthrough failure exposed on macOS with Bash `set -u`:

- `launch_step()` resolves the guided root before deriving repository and guide paths;
- evidence collection and recovery restoration use the same dependency-safe local-variable initialization;
- unknown guided step identifiers fail explicitly instead of producing an empty guide path; and
- an executable regression runs guided steps 3–5 through launch, evidence collection, checkpoint inspection, result recording, and archive creation.

## Alpha.22 codesearch timeout-output correction

Alpha.22 corrects the remaining macOS timeout regression exposed by the supported deterministic check:

- codesearch indexing uses the asynchronous bounded process runner rather than `spawnSync()`;
- timeout rejection waits for the child process streams to close, retaining stderr and stdout emitted before termination;
- timed-out, idle, or aborted process groups escalate from `SIGTERM` to `SIGKILL` after one second; and
- regression coverage verifies both the generic process runner and the codesearch provider preserve partial timeout output.

## Alpha.21 codesearch fresh-index and diagnostic correction

Alpha.21 corrects the live codesearch failure exposed by the alpha.20 acceptance harness:

- a fresh clone no longer receives `codesearch index --force` merely because MCP startup created the database before the CLI indexer ran;
- an empty database left by an interrupted first index is retried through the normal index path;
- populated indexes still receive one forced rebuild when corpus-selection inputs or provider version change; and
- index failures retain the timeout/error metadata as well as partial provider output.

## Alpha.20 deterministic Git and sandbox-test correction

Alpha.20 corrects the two workstation-dependent failures reported by the supported macOS check:

- Atelier Git commits pass `--no-gpg-sign`, so a signing-enabled workstation cannot require an SSH/GPG agent that the minimal subprocess environment intentionally excludes;
- non-secret Git isolation controls such as `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` survive environment minimization;
- the per-turn shell-approval regression explicitly disables the sandbox backend instead of depending on the host operating system; and
- provider-level coverage reproduces SSH commit signing with no agent and verifies successful reviewed task finalization.

## Alpha.19 execution-boundary and workspace-finalization correction

Alpha.19 closes the remaining review defects at the active authorization and repository boundaries:

- repository project configuration may no longer select provider or editor executables;
- Pi shell-effect extraction and the hardened core classifier must agree before a command receives read-only workflow authority;
- every shell command receives a concrete one-operation warning and approval when Seatbelt or Bubblewrap is unavailable;
- unsandboxed execution authority is limited to the exact approved invocation;
- the adversarial corpus exercises effect extraction, workflow authorization, workspace policy, and executor selection together; and
- reviewed multi-repository tasks now use workspace-wide validation freshness, scoped per-repository commits, combined final-diff review, clean-state checks, metadata finalization, and explicit partial-failure reporting.

## Alpha.18 expandable report-card correction

Alpha.18 makes consecutive persistent reports visually distinct and reduces sparse or diagnostic-heavy output:

- every report renders a horizontal divider plus a concise summary header;
- collapsed entries use `➤`, expanded entries use `▼`, following Pi's persistent-entry expansion state;
- `/status` uses concise bold field/value lines instead of a sparse table;
- `/workflow` is the canonical durable workflow report and `/state` remains a compatibility alias;
- `/workflow full` retains the complete diagnostic Working State when deep inspection is required;
- default workflow output omits empty sections and summarizes task, execution, validation, retrieval, and blockers; and
- dense ready-task and code-result collections retain tables or grouped sections where they improve scanning.

## Deterministic verification

```sh
npm run check:metadata
npm run typecheck
npm run build
npm test
bash scripts/smoke.sh
bash -n scripts/live-acceptance.sh
bash -n scripts/guided-verification.sh
git diff --check
npm pack --dry-run
```

The final working tree passed:

```text
Release metadata:     passed
Type-check:           passed
Build:                passed
Deterministic tests:   292 passed, 0 failed
Guided regressions:    6 passed, 0 failed
Interactive perf tests: 3 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.32
Files:            474
Compressed size:  537,170 bytes
Unpacked size:    2,516,905 bytes
```

## Verification boundary

The correction environment provides Node 22.16.0 and TypeScript 5.8.3 rather than the supported Node 24.18.0
and TypeScript 7 toolchain. Type-checking and production compilation pass. All 292 deterministic tests pass through
the aggregate eight-way command. The pinned
Node 24 `mise check` remains authoritative for the supported runtime and macOS path-alias confirmation.

The standalone smoke workflow, package dry-run, release metadata check, and script syntax pass. Bundle and
fresh-checkout verification are performed after the release commit and annotated tag are created. Live Jujutsu, Seatbelt, Bubblewrap,
codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise and live-conformance
environments.

## Release classification

`0.14.0-alpha.32` remains an interactive alpha. Footer status is event-driven and provider-neutral:
model and thinking selections update immediately; workflow, task, closure, Git/Jujutsu, and intelligence
state refresh after authoritative lifecycle events; and source drift degrades stale index readiness until a
current index completes. Atelier deliberately does not poll continuously while Pi is completely idle, so
changes made by an unrelated external process appear on the next Pi input, command, tool result, or agent
lifecycle event. Arbitrary interpreters, scripts, build systems, and dynamically computed shell effects
remain intentionally conservative and require one concrete approval unless their effects can be bounded
and recovered.
