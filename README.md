# Atelier

Atelier is a local-first Agentic Development Environment control plane for Pi. The CLI is `atlr`.
Atelier owns reviewed-plan execution, task reconciliation, authorization, durable evidence,
validation closure, Working State, and code-provider orchestration. Editors, Jujutsu/Git, Beads,
codesearch, Octocode, and validation commands retain their native responsibilities.

Current release: **0.14.0-alpha.7**.

## Current status

This release is intended for interactive use in explicitly trusted repositories. It is not a shell
sandbox and does not claim that arbitrary shell commands are confined to a repository. Generic shell
execution is classified as an unconfined boundary and requires a one-operation approval. Routine
approved-task work is approval-free only through typed Atelier/Pi tools whose paths and effects can be
checked.

Do not use this alpha for unattended execution or arbitrary cloned repositories. Trust is a deliberate
user decision stored outside the repository.

## Delivered workflow

Atelier currently provides:

- durable `ManualEdit` plan review with exact plan hashes and structural diffs;
- preview-before-mutation task-provider reconciliation;
- exact approval bound to source revisions, every approved workspace repository, retrieval revisions,
  provider identity, reconciliation digest, and a typed task-capability bundle;
- atomic task claim, execution activation, and capability installation;
- restart-safe execution, invalidation, permission, mutation, validation, and retrieval evidence;
- an authoritative task-closure predicate requiring current required validations, an exact final-diff
  review, a local commit/change, and the configured clean-repository state;
- Jujutsu-first and Git-compatible repository providers;
- Beads, memory, and disabled task providers;
- codesearch, Octocode, mock, and disabled code providers;
- CLI and Pi integration.

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

## Project trust

Repository-owned configuration is ignored until the user trusts the project:

```sh
atlr trust status
atlr trust add --yes
atlr init
```

The trust record is stored under the user state directory, normally:

```text
~/.local/state/atelier/trusted-projects.json
```

`ATLR_TRUST_STORE` can override that location, but the trust store must remain outside the project.
Before trust, Atelier does not start repository-configured VCS, task, validation, editor, or code-provider
commands. `atlr doctor` is observational: it does not open the ledger, start providers, or create project
state.

Revoke trust with:

```sh
atlr trust revoke --yes
```

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

Free-form Scope and Out-of-scope sections remain human context; the `execution` object is the authorization
source. Missing, unknown, inconsistent, absolute, out-of-root, or non-source entries fail preparation. See
`docs/PLAN_FORMAT.md` for the complete contract.

A normal CLI workflow is:

```sh
atlr trust add --yes
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
- the typed task-capability bundle and its digest.

Rejection performs no provider mutation. Approval reconciles the provider, verifies convergence, claims
one approved-plan ready task, and atomically installs the execution grant plus its typed capabilities.
A later approved task still requires explicit activation:

```sh
atlr execute TASK_ID --yes
```

Cancellation revokes the active execution and linked permissions without silently closing the task:

```sh
atlr cancel --reason "why execution stopped"
```

In Pi, `/atelier-stop` ends only the current turn, `/atelier-pause` keeps the execution/task active while
denying agent mutation, `/atelier-resume` re-enables it without starting a turn, and `/cancel` atomically
revokes execution without waiting for idle. Denial, Escape, or normal settlement never schedules a forced
follow-up. The completion predicate is enforced when closure is requested, not by preventing the user
from regaining control.

## Authorization model

Plan approval is not blanket command authorization.

The approved task receives only the capabilities derived from its machine-readable execution contract:
exact source paths, explicitly named validations, optional dependency manifests, task closure, and an
optional path-scoped local commit/change. Task update/link permissions are not granted implicitly. A typed
operation is allowed only when its resolved real path, validation name, task, repository, and execution
bindings match the reviewed contract.

Generic shell commands use the `unconfined` boundary. They never inherit typed task capabilities, even
when a classifier recognizes a read-like command. Each unconfined shell operation requires an explicit
single-operation grant. Destructive, network, publication, unknown, and out-of-scope effects remain
approval-gated or denied according to policy.

Atelier resolves existing paths and the nearest existing ancestor for new paths. Symlink escapes do not
satisfy repository confinement. This path check protects typed operations; it is not an operating-system
sandbox for arbitrary child processes.

The durable model now exposes only meaningful grant scopes:

```text
operation   consumed when one authorization is attempted
task        bound to the active execution/task
repository  bound to a trusted repository identity
```

Legacy `turn` and `session` grants are revoked during migration.

## Validation and task closure

`.atelier/validation.json` declares argument-array commands and the closure policy. A minimal manifest:

```json
{
  "closurePolicy": {
    "requireValidation": true,
    "requireFinalDiffReview": true,
    "requireLocalChange": true,
    "requireCleanGit": true
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

Pi exposes `atlr_validate` as the model-facing typed validation tool. It plans or runs trusted declared
validations without routing them through generic Bash. Failed declared checks fail the tool operation; an
explicitly interrupted check returns a structured interrupted result so user cancellation is not recast as
a validation failure. Durable validation evidence is retained in both cases. Capability is not instruction: a user request not
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

An additional workspace root must be separately approved outside repository configuration:

```sh
atlr trust workspace add ../another-repository --yes
```

Then declare it in `.atelier/workspace.json`. Each repository receives a real VCS snapshot. Exact
approval and resume bind every root independently; drift in a secondary repository invalidates the
execution rather than reusing stale retrieval evidence.

Remove an approved secondary root with:

```sh
atlr trust workspace revoke ../another-repository --yes
```

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

Pi reserves `/trust` for Pi-owned project resources. Atelier uses `/atelier-trust` for the separate external trust record that gates `.atelier` configuration and provider execution. The CLI remains `atlr trust ...`.

Core slash commands include:

```text
/atelier-trust
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
enforceable active-turn control. A capability authorizes an operation; it never instructs the model to use
it.

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

- Generic shell execution is unconfined and individually approved; no OS sandbox is delivered.
- Trusting a project permits its declared providers, validators, and editor command to execute.
- Live provider conformance depends on locally available external tools and is separate from deterministic
  CI.
- Multi-repository source/retrieval revision correctness is delivered, but richer coordinated editing UX
  remains limited.
- `session_before_compact` reconstructs durable Working State into Pi compaction; compaction has not yet
  been eliminated entirely.
- The IDE-facing palette, tree, navigator, and dedicated diff surfaces are not yet implemented.
