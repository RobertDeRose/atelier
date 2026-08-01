# Build Report — Atelier 0.14.0-alpha.28

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
Guided regressions:    5 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.28
Files:            446
Compressed size:  494,790 bytes
Unpacked size:    2,313,522 bytes
```

## Verification boundary

The correction environment provided Node 22.16.0 and TypeScript 5.8.3 rather than the supported
Node 24.18.0 and TypeScript 7 toolchain. All 278 deterministic tests across 83 test files passed in
bounded independent processes using the required `--test-concurrency=8` setting. After the final
footer-module extraction, the aggregate Node 22 test-runner process did not terminate reliably, which
matches the previously observed unsupported-runtime limitation. The pinned Node 24 CI and maintainer
`mise check` remain authoritative for the supported aggregate command.

The environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap` binary. Exact Git
recovery is exercised against real Git repositories. Jujutsu operation recovery and sandbox command
construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu, Seatbelt,
Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise and
live-conformance environments.

## Release classification

`0.14.0-alpha.28` remains an interactive alpha. Footer status is now event-driven and provider-neutral:
model and thinking selections update immediately; workflow, task, closure, Git/Jujutsu, and intelligence
state refresh after authoritative lifecycle events; and source drift degrades stale index readiness until a
current index completes. Atelier deliberately does not poll continuously while Pi is completely idle, so
changes made by an unrelated external process appear on the next Pi input, command, tool result, or agent
lifecycle event. Arbitrary interpreters, scripts, build systems, and dynamically computed shell effects
remain intentionally conservative and require one concrete approval unless their effects can be bounded
and recovered.
