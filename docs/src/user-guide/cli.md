# CLI reference

The CLI executable is `atlr`. Global options may be placed before the command:

```text
atlr [--root PATH] [--workspace PATH] [--retrieval-session ID] COMMAND
```

Most inspection commands accept `--json`. Use `--yes` for a mutation that
would otherwise ask for interactive confirmation. A non-interactive planned
approval always needs the exact prepared approval ID, matching reconciliation
digest, and `--yes`.

## Start with inspection

Use these commands before changing workflow state:

```sh
atlr doctor
atlr status
atlr state
atlr repo status
atlr workspace status
atlr changed
atlr ready
```

`atlr doctor` is observational and does not create the ledger or start
providers. `status` gives a compact workflow view. `state` renders the
reconstructed task-backed Working State, including the next action, approvals,
execution grant, evidence, and closure blockers. `repo status` identifies the
Git or Jujutsu provider; `workspace status` reports all configured repository
identities. `changed` lists the current changed paths, and `ready` lists
provider-reported unblocked work.

Useful focused inspection commands include:

| Command                         | Purpose                                                  |
|---------------------------------|----------------------------------------------------------|
| `atlr task show TASK_ID`        | Read one task without claiming or changing it            |
| `atlr files`                    | List tracked repository files                            |
| `atlr tree`                     | Show a bounded project tree                              |
| `atlr open PATH[:LINE]`         | Open a path in the resolved editor                       |
| `atlr config validate`          | Validate project and retrieval configuration             |
| `atlr policy command "COMMAND"` | Show shell classification and workspace decision as JSON |
| `atlr sandbox status`           | Report available shell confinement                       |
| `atlr ledger tail --limit 25`   | Inspect recent durable events                            |

`atlr task claim` is intentionally not a supported shortcut: direct claims
would bypass exact execution authorization. Use an approval or task-start
command instead.

## Plan and review

A planned workflow starts in plan mode and creates the plan document if it is
missing:

```sh
atlr plan "Add the requested capability"
atlr plan parse
atlr review
```

`atlr plan` sets guarded plan mode and prints the path to review. `plan parse`
validates headings, task metadata, execution contracts, and dependencies. Repository
quality-gate inventory is recorded during preparation; legacy validation names remain
readable for compatibility. `review` opens the configured editor, records a durable
`ManualEdit`, and prints the structural diff, diagnostics, and reconciliation
preview.

The plan subcommands are:

```sh
atlr plan create
atlr plan parse --json
atlr plan reconcile --json
atlr plan prepare --json
atlr plan scope TASK_ID --write PATH[,PATH] \
  [--validation NAME[,NAME]] [--dependencies] [--full-suite] [--no-local-change]
```

- `create` creates the plan document without starting approval.
- `parse` validates the current document and exits nonzero when it has errors.
- `reconcile` previews provider operations without applying them. Do not use
  an `--apply` flag; the CLI rejects that shortcut.
- `scope` updates one task's machine-readable execution contract using
  canonical paths. Re-review and prepare after changing scope.
- `prepare` records the exact approval transaction and returns its ID and
  reconciliation digest. It does not mutate the task provider.

For a plan that is already drafted, the exact non-interactive sequence is:

```sh
atlr review
atlr plan prepare --json
atlr approve --approval APPROVAL_ID \
  --digest RECONCILIATION_DIGEST --yes
```

Read the plan hash, provider identity, operations, retirements, proposed first
task, exact paths, quality-gate coverage, and exclusions before approving. Rejection or
drift performs no partial approval. A successful approval applies the reviewed
reconciliation, claims the first approved task, installs its execution grant,
and leaves the agent idle until an explicit implementation request.

## Standalone task activation

A ready task can be activated without creating or reconciling a plan:

```sh
atlr approve --task TASK_ID --yes
```

The command displays the task and effective scope before confirmation. Without
`--write`, the scope is all application-source paths; Atelier metadata,
provider state, and dependency manifests remain excluded by default. Narrow
scope explicitly:

```sh
atlr approve --task TASK_ID \
  --write src/,tests/ --yes
```

The optional controls are:

- `--dependencies` permits dependency manifest or lockfile changes;
- `--full-suite` remains a legacy compatibility control;
- `--no-local-change` makes a local change unnecessary for this task.

The equivalent task command is:

```sh
atlr task start TASK_ID --standalone \
  --write src/,tests/ --yes
```

Standalone activation never writes, reviews, or reconciles `.atelier/PLAN.md`.
It still requires workspace authorization, discovered quality-gate evidence,
final-diff, cleanliness, commit, and closure rules. Legacy `--validation` input
is optional compatibility data and is not required for new activation.

## Activate and control work

After the first planned task is closed, later approved-plan work is never
started automatically. Activate it explicitly:

```sh
atlr execute [TASK_ID] --yes
```

The CLI confirms the previous approved execution and the requested next task.
To resume a task that was cancelled rather than merely paused:

```sh
atlr resume-task [TASK_ID] --yes
```

Pause, resume, and cancel have different meanings:

```sh
atlr pause --reason "Need to inspect an external change"
atlr resume
atlr cancel --reason "Discard this execution attempt"
```

`pause` keeps the task and reviewed constraints active but denies agent
mutation. `resume` re-enables that execution without starting an agent turn.
`cancel` revokes execution and leaves the task and source files open; it does
not revert edits. `resume-task` revalidates a cancelled approved task's exact
bindings before issuing a new grant.

## Quality gates and compatibility evidence

New plan and standalone approval discovers repository quality gates from native
hooks, configured tools, `mise`, and package scripts. Inspect the inventory and
planning coverage without naming a check:

```sh
atlr dstack gates
atlr plan prepare --json
atlr state
atlr evidence
```

The selected gate runs automatically before `repo commit` and `task close`.
Failures, unavailable tools, stale configuration, cancellation, and formatter
or hook mutations block the operation and retain bounded evidence. `evidence`
and `state` show the current quality-gate status, exact identity, output, and
freshness. An approved no-gate repository is reported explicitly; it is not
silently treated as a passing check.

Existing `.atelier/validation.json` definitions and rows remain readable as
legacy compatibility data. The compatibility commands are still available for
inspection or an intentionally named historical check:

```sh
atlr validate list
atlr validate plan
atlr validate focused
atlr validate run NAME
atlr evidence --name NAME
```

Legacy validation evidence is marked historical compatibility when the active
execution uses quality gates. Do not add validation names to new task contracts
or use a legacy result as a substitute for current quality-gate evidence.

If a user explicitly accepts the risk, one commit may skip the selected quality
gate without weakening Git policy:

```sh
atlr repo commit --message "type(scope): summary" --bypass-quality-gate --yes
```

The bypass is audited, source-bound, and expires before another commit. Hooks,
signing, filters, and task scope still apply.

## Final diff, local change, and closure

The completion sequence is intentionally separate:

```sh
atlr repo review-diff
atlr repo commit --message "docs(user-guide): expand CLI and Pi workflows"
atlr task close TASK_ID --reason "Documentation reviewed and validated"
```

`repo review-diff` prints and hashes the exact current task diff, then records
review only if it is unchanged. `repo commit` creates the one task-scoped Git
commit or Jujutsu change allowed by the execution grant. `task close` enforces
current required validation, exact diff review, local-change, and repository
quality-gate, exact diff, local-change, and repository-state evidence. If any requirement is missing or stale, `atlr state` explains
what to do next.

## Code intelligence

The code group owns the provider-neutral interface and evidence boundary:

```sh
atlr code providers --json
atlr code status --provider codesearch
atlr code index --provider codesearch
atlr code search "where is approval applied" --mode hybrid --focus source
atlr code symbols ExecutionWorkflowCoordinator
atlr code related REFERENCE --kind references --depth 1 --limit 20
atlr code doctor --json
```

Supported groups are `providers`, `status`, `index`, `search`, `symbols`,
`related`, and `doctor`. Search accepts `--provider`, `--repo`, `--limit`,
`--mode auto|semantic|hybrid|lexical`, `--focus auto|source|tests|docs|all`,
and `--hint IDENTIFIER[,IDENTIFIER...]`. `related` additionally accepts
`--repo`, `--path`, `--kind imports,calls,dependencies,references`, `--depth`,
and `--limit`.

Provider results include provenance, workspace/repository scope, freshness,
deduplication, truncation, and remaining budgets when `--json` is used. Read
returned paths directly; a budget limit is not an authorization denial. Use
`atlr code status` before another request, and reindex when the provider is
stale or failed.

For local codesearch, status also performs a read-only lock-ownership check.
If it reports a database lock, the listed PID is using the local `.codesearch.db`;
close the owning Pi/Atelier session (or resolve a stale `codesearch` process)
before running `atlr code index` again. Atelier never terminates a reported
process automatically. Client/serve-backed providers do not inspect a local
repository database.

## Repository, runtime, and service commands

The remaining supported command groups are:

| Group                   | Commands and purpose                                                |
|-------------------------|---------------------------------------------------------------------|
| `init`                  | Create project files; add `--beads` to initialize the task provider |
| `doctor`                | Observational health report; add `--json`                           |
| `mode`                  | Set `investigate`, `plan`, or `act`                                 |
| `repo`                  | `status`, `review-diff`, and `commit`                               |
| `config`                | `validate`                                                          |
| `changed`               | List current changed paths                                          |
| `state`                 | Build Working State; `--task TASK_ID` narrows the task view         |
| `data`                  | `inspect`, `prune [--days N --keep N]`, `delete --yes`, or `export` |
| `ledger`                | `tail [--limit N]` for recent durable events                        |
| `recovery`              | `list` or `restore CHECKPOINT_ID`                                   |
| `workspace`             | `status` for repository ownership and revisions                     |
| `files`, `tree`, `open` | Navigate tracked files and the configured editor                    |
| `serve`                 | Run a local Core service, optionally with `--socket PATH`           |
| `service`               | `status`, `state`, or `stop` for a running service                  |

`atlr data delete --yes` removes retained historical evidence, not source
files. Inspect or export first. `atlr recovery restore CHECKPOINT_ID` restores
the exact checkpointed state and should be used only after reading the
checkpoint details.

Use `atlr service status` or `atlr service state` only when a Core service is
running. The default socket is under the external runtime directory; use the
same `--socket PATH` with `atlr serve` and `atlr service` when selecting a
custom socket.

For complete command discovery:

```sh
atlr --help
atlr --version
```
