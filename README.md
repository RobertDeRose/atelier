# Atelier

Atelier is a local-first Agentic Development Environment control plane for Pi. The CLI is `atlr`.
Atelier owns reviewed-plan execution, task reconciliation, authorization, durable evidence,
validation closure, Working State, and code-provider orchestration. Editors, Jujutsu/Git, Beads,
codesearch, Octocode, and validation commands retain their native responsibilities.

Current release: **0.14.0-alpha.15**. Persistent inspection reports are rendered by the Markdown component and theme supplied by the active Pi host.

## Current status

Atelier establishes an immutable session workspace from the canonical startup directory. Ordinary non-secret reads, file creation, and recoverable in-workspace mutations proceed without setup or repetitive approval. Atelier asks only when an operation may escape the workspace, expose a likely secret, require privilege escalation, or cannot be recovered exactly.

Pi `/trust` remains independent and controls only project-local Pi resources. Generic shell execution uses a workspace sandbox through macOS Seatbelt or Linux Bubblewrap when available; otherwise indeterminate persistent effects require explicit one-operation approval.

This remains an interactive alpha. Do not use it for unattended privileged execution.

## Delivered workflow

Atelier currently provides:

- durable `ManualEdit` plan review with exact plan hashes and structural diffs;
- preview-before-mutation task-provider reconciliation;
- exact approval bound to source revisions, every approved workspace repository, retrieval revisions,
  provider identity, reconciliation digest, and reviewed task constraints;
- atomic task claim and execution activation with reviewed task constraints;
- restart-safe execution, invalidation, recovery-checkpoint, mutation, validation, and retrieval evidence;
- an authoritative task-closure predicate requiring current required validations, an exact final-diff
  review, a local commit/change, and the configured clean-repository state;
- Jujutsu-first and Git-compatible repository providers;
- Beads, memory, and disabled task providers;
- codesearch, Octocode, mock, and disabled code providers;
- CLI and Pi integration, including a responsive two-line footer with model/context, workflow mode,
  human-readable task titles, code-index health, and provider-native Jujutsu/Git cleanliness;
- persistent TUI-only Markdown reports for status, Working State, code intelligence, changed paths,
  validation, evidence, and ready-work inspection without adding those reports to model context;
- approval-only plan activation that leaves Pi idle until the user explicitly requests implementation.

The fuzzy file palette, project tree, Yazi/skim adapters, and richer Helix-native IDE surfaces remain
future work. They are intentionally gated on the guarded workflow rather than being treated as current
features.

## Requirements

The supported development toolchain is pinned by the repository:

- Node.js 24.18.0;
- Aube and the tools declared through mise;
- TypeScript 7 through the lockfile/toolchain;
- Jujutsu, Beads, and codesearch for their corresponding live integrations;
- Bun and Pi for the interactive extension path.

Git can be used as the repository compatibility provider. Optional providers are not required for the
deterministic fixture suite.

## Install and build

```sh
mise install
mise run install
npm run build
node ./bin/atlr.mjs --version
npm run check
```

`bin/atlr.mjs` launches built JavaScript from `dist/`. Development-only source execution remains
available as `npm run atlr:dev -- ...` and `npm run launch:dev`.

The package publishes built JavaScript and declarations through:

```text
dist/packages/core/src/index.js
dist/packages/core/src/index.d.ts
dist/apps/pi-extension/src/index.js
```

## Workspace policy and Pi trust

Atelier establishes the canonical startup directory as the immutable filesystem workspace for the current session. No Atelier trust command, trust database, or persistent workspace approval is required.

```sh
cd /path/to/repository
atlr doctor
atlr init
```

Pi `/trust` remains independent. It controls loading project-local Pi resources; it does not grant Atelier filesystem authority. Atelier evaluates concrete filesystem effects against workspace containment, likely-secret paths, privilege escalation, and VCS/checkpoint recoverability.

`atlr doctor` is observational: it does not open the ledger, start providers, or create project state.

## Project files and runtime state

Shareable project data lives under `.atelier/`:

```text
.atelier/config.json       project configuration
.atelier/PLAN.md           reviewed plan
.atelier/validation.json   validation and closure policy
.atelier/workspace.json    optional multi-repository workspace
```

Runtime state is user-owned and outside the repository. By default it is stored at:

```text
${XDG_STATE_HOME:-~/.local/state}/atelier/repositories/<root-hash>/atelier.db
```

`ATLR_STATE_HOME` or user configuration can relocate runtime state. Repository configuration cannot
redirect the ledger or caches. Legacy `.atelier/*.db` files are ignored, but `.atelier/config.json`,
`PLAN.md`, `validation.json`, and `workspace.json` are intentionally trackable.

## Exact plan-to-task workflow

Every approvable task includes a structured execution contract in its `atlr:task` marker. For example:

```markdown
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["src/example.ts","tests/example.test.ts"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->
```

Free-form Scope and Out-of-scope sections remain human context; the `execution` object is the reviewed task-constraint source. Missing, unknown, inconsistent, absolute, out-of-root, or non-source entries fail preparation. See
`docs/PLAN_FORMAT.md` for the complete contract.

A normal CLI workflow is:

```sh
atlr init --beads
atlr plan "describe the objective"
atlr review
atlr plan prepare --json
atlr approve --approval APPROVAL_ID --digest RECONCILIATION_DIGEST --yes
atlr status
```

Preparation records and approval rechecks:

- the exact reviewed plan hash;
- task-provider name and version;
- the complete reconciliation digest and conflicts;
- the primary source snapshot;
- revision bindings for every approved workspace repository;
- retrieval provider/index bindings used by the plan;
- the reviewed task constraints and their digest.

Rejection performs no provider mutation. Approval reconciles the provider, verifies convergence, claims
one approved-plan ready task, and atomically installs the execution grant plus its reviewed task constraints.
A later approved task still requires explicit activation:

```sh
atlr execute TASK_ID --yes
```

Cancellation revokes the active execution without silently closing the task:

```sh
atlr cancel --reason "why execution stopped"
```

In Pi, `/atelier-stop` ends only the current turn, `/atelier-pause` keeps the execution/task active while
denying agent mutation, `/atelier-resume` re-enables it without starting a turn, and `/cancel` atomically
revokes execution without waiting for idle. Denial, Escape, or normal settlement never schedules a forced
follow-up. The completion predicate is enforced when closure is requested, not by preventing the user
from regaining control.

## Workflow constraints and workspace recoverability

Plan approval constrains the active task; it does not create a second filesystem permission system.
The reviewed execution contract limits agent work to exact source paths, explicitly named validations,
optional dependency manifests, task closure, and an optional path-scoped local commit/change. Workflow
mode and task identity remain hard constraints, while the workspace policy independently decides whether
each concrete filesystem effect is contained and exactly recoverable.

The workspace policy evaluates four things:

1. resolved path containment inside the immutable session workspace;
2. likely-secret and privilege-escalation consequences;
3. VCS path state through Git or Jujutsu;
4. exact recovery through VCS state or a verified Atelier checkpoint.

Ordinary non-secret reads, new files, clean tracked mutations/deletions, and content-preserving untracked
mutations proceed without approval. Dirty tracked destruction and recoverable untracked/ignored
destruction receive an automatic checkpoint. Outside-workspace effects, likely-secret access, privilege
escalation, indeterminate destructive path sets, and any operation Atelier cannot restore exactly ask once
for the concrete consequence.

Git checkpoints preserve the exact index, staged/unstaged and partially staged contents, modes, renames,
symlinks, ignored files, and affected untracked files without changing branch history or staging user work.
Jujutsu checkpoints capture and verify the native operation-log boundary. Checkpoints are associated with
the triggering Pi session and tool call and expose an explicit restore command.

Pi's model Bash tool and direct `user_bash` execution share the same pre-execution evaluator. Seatbelt on
macOS or Bubblewrap on Linux is used when available. An unavailable sandbox does not bypass policy:
execution may fall back only after the concrete effects were allowed, checkpointed, or explicitly approved.
Sandbox confinement alone never turns an indeterminate destructive operation into a recoverable one.
Existing targets and nearest existing ancestors are resolved securely, so lexical traversal, nested
symlinks, broken symlinks, and nonexistent descendants cannot escape the workspace boundary.

## Validation and task closure

`.atelier/validation.json` declares argument-array commands and the closure policy. A minimal manifest:

```json
{
  "closurePolicy": {
    "requireValidation": true,
    "requireFinalDiffReview": true,
    "requireLocalChange": true,
    "requireCleanSource": true,
    "requireCleanRepository": true
  },
  "validations": {
    "check": {
      "command": ["npm", "run", "check"],
      "category": "full",
      "required": true
    }
  }
}
```

When `requireValidation` is true, configuration and task closure require at least one applicable
validation with `required: true`. Readiness distinguishes a missing focused selection, a selection that
matched no required check, and a manifest with no required validation. The removed `approval` field is
rejected rather than silently ignored. Validation output is bounded and redacted, execution is
abort-aware, and evidence includes repository and environment fingerprints. Repository, command,
toolchain, platform, architecture, PATH, or lockfile drift makes prior evidence stale.

Pi exposes `atlr_validate` as the model-facing typed validation tool. It plans or runs configured declared
validations without routing them through generic Bash. Failed declared checks fail the tool operation; an
explicitly interrupted check returns a structured interrupted result so user cancellation is not recast as
a validation failure. Durable validation evidence is retained in both cases. A reviewed constraint is not an instruction: a user request not
to validate remains binding.

A typical completion sequence is:

```sh
atlr repo commit --message "feat: implement approved task"
atlr validate plan
atlr validate focused
# or: atlr validate run check
atlr repo review-diff
atlr task close TASK_ID --reason "implemented and verified"
```

`repo review-diff` prints the exact task diff, hashes it, then records review only if the diff is still
unchanged. Task closure is blocked unless all configured requirements are current. Pi may display one
passive incomplete-task notice, but it does not enqueue another agent turn. The same predicate is used by
CLI, Pi, Working State, and task closure.

## Repository providers

Jujutsu is preferred and Git is the compatibility provider. Repository observations are explicit:
provider command failures throw a degraded/error state and are never converted into an empty path list
or clean diff. Git diff evidence includes staged and unstaged changes, while baseline diff evidence also
includes untracked source files.

```sh
atlr repo status --json
atlr changed --json
```

## Multi-repository workspaces

Start Atelier with an explicit common workspace root when repositories are siblings or nested below a shared directory:

```sh
atlr --workspace ../workspace workspace status
atlr --workspace ../workspace launch
```

Declare repository identities in `.atelier/workspace.json`. Each repository receives an independent VCS snapshot. Task execution paths use `repository-id::relative/path` when they target a non-primary repository. Exact approval and resume bind every repository independently; secondary drift invalidates execution rather than reusing stale evidence.

No persistent trust or workspace approval is created. The explicit workspace applies only to the current process.

## Code intelligence

Atelier owns the provider-neutral contract, budgets, normalized evidence, provenance, freshness, and
reuse. External providers own indexing and retrieval.

```sh
atlr code providers --json
atlr code status --provider codesearch
atlr code index --provider codesearch
atlr code search "where is execution approval implemented" --mode hybrid
atlr code symbols ExecutionWorkflowCoordinator
```

Explicit CLI and `/code-symbols` requests perform direct human-requested symbol lookup. The model-facing
symbol tool remains inventory-gated. Provider display signatures are normalized to canonical identifiers,
exact definitions rank before references, and resolved/unresolved state is repository-scope qualified.

Provider-first retrieval is advisory, not an authorization gate. Atelier presents provider tools first
and records degraded/fallback decisions, but typed reads and explicitly approved shell inspection remain
available when provider evidence is incomplete, wrong, excluded, or budget-limited.

Retrieval evidence is isolated by provider, workspace, repository scope, source revision, and provider
index revision. Equivalent current evidence can be reused; revision drift invalidates it.

## Pi integration

Launch the supported interactive path with:

```sh
atlr launch
# or
mise run launch
```

Pi reserves `/trust` for Pi-owned project resources. Atelier does not register another trust command and does not use Pi trust as filesystem authority. The Atelier workspace policy is established from the startup directory or `--workspace`.

Structured inspection commands render as persistent Markdown entries in Pi transcript scrollback. Status-like
reports use compact tables; Working State uses headings and lists; code search separates definitions,
references, source, tests, documentation, and generated results. Short lifecycle events continue to use
transient notifications.

Core slash commands include:

```text
/plan
/review
/approve
/execute
/atelier-stop
/atelier-pause
/atelier-resume
/cancel
/status
/state
/code-status
/code-index
/code-search
/code-symbols
/changed
/validate
/evidence
/commit
/review-diff
/close
```

The registered model tools include:

```text
atlr_code_status
atlr_code_search
atlr_code_symbols
atlr_state
atlr_validate
atlr_commit
atlr_task_close
```

Explicit user prohibitions such as “do not use Bash”, “do not validate”, “do not commit”, or “do not
close” form a temporary turn policy that blocks those tools before an exceptional approval prompt. A
“stop after” instruction is also injected into the current-turn prompt, while `/atelier-stop` is the
enforceable active-turn control. A reviewed task constraint permits a bounded workflow operation; it never instructs the model to use it.

Each Pi session owns its own Atelier Core, repository root, review state, retrieval session, and index
coordination. Shutdown awaits provider disposal before closing SQLite. Compaction receives a projection
of durable Working State; conversation text remains non-authoritative.

## Checks and conformance

Deterministic CI runs on the pinned Node version and executes:

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` performs release-metadata checks, type checking, all deterministic tests, a stable build,
and the smoke workflow. Environment-dependent live conformance is separate and manually dispatchable for
real Jujutsu, codesearch, Beads, and Pi/Bun installations. Fixture conformance is never represented as a
live provider result.

## Current limitations

- Static shell effect analysis is deliberately conservative. Interpreter, build-system, and compound
  commands ask when their persistent effects cannot be enumerated exactly, even when an OS sandbox is active.
- Seatbelt and Bubblewrap are platform facilities, not a complete VM boundary; network policy remains a
  separate concern and privileged execution always asks.
- Live provider conformance depends on locally available external tools and is separate from deterministic CI.
- Multi-repository source/retrieval revision correctness is delivered, but richer coordinated editing UX remains limited.
- Every turn reconstructs authoritative Working State, but Pi's transcript and compaction mechanism still exist.
- The current palette, tree, navigator, and diff surfaces are functional command surfaces rather than a complete IDE chrome.
