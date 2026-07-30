# Atelier Plan Format, Version 1

An Atelier plan is Markdown with one machine-readable metadata comment directly below each task heading.
Human-readable sections explain intent; the metadata supplies stable identity and exact execution authority.
Atelier never widens reviewed task constraints from prose. Filesystem authorization is decided separately by the session workspace recoverability policy.

## Required task structure

Each task starts with either:

```markdown
## ATLR-001 — Task title
```

or:

```markdown
## [ATLR-001] Task title
```

The next metadata comment must include the same stable ID plus an `execution` object:

```markdown
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["packages/core/src/version.ts","tests/version.test.ts"],"allowDependencyChanges":false,"validations":["manual-acceptance"],"allowFullSuite":false,"allowLocalChange":true}} -->
```

Supported task types are `bug`, `feature`, `task`, `epic`, and `chore`. Priorities are integers from `0`
through `4`; lower values are selected first when dependency state is otherwise equal.

## Execution contract

The execution object is mandatory before ManualEdit review can advance to approval.

| Field | Meaning |
|---|---|
| `writePaths` | Non-empty repository-relative source files or directories the task may modify. Absolute paths and `..` escapes are rejected. |
| `allowDependencyChanges` | Whether dependency manifests/locks named in `writePaths` are included in the reviewed task constraint. Ordinary source-path scope never implies dependency changes. |
| `validations` | Exact names from `.atelier/validation.json` that this task may run. Unknown names are rejected. |
| `allowFullSuite` | Whether named validations whose category is `full` may run. Naming one while this is false is rejected. |
| `allowLocalChange` | Whether Atelier may create one path-scoped local Git commit or Jujutsu change for the task. |

When closure policy requires validation and the manifest contains required checks, the task must name at
least one configured required validation. A plan cannot approve an execution that has no possible closure
path.

Directory entries intentionally authorize descendants after symlink-aware real-path checking. Exact file
paths are preferred for small tasks because the approval summary shows them directly.

Human-readable Scope and Validation sections should describe the same boundary, but disagreement never
widens authority: the execution object is authoritative and its projection is displayed before approval.

## Recognized sections

- `Goal`
- `Description`
- `Scope` or `In scope`
- `Out of scope` or `Exclusions`
- `Depends on`, `Dependencies`, or `Blockers`
- `Validation` or `Tests`
- `Completion criteria`, `Acceptance`, or `Acceptance criteria`
- `Notes` or `Design`

Dependencies refer to stable plan task IDs, not provider task IDs.

## Structural review

A plan `ManualEdit` compares task order and every canonical parsed field: stable ID, title, goal,
description, scope, exclusions, dependencies, validation, completion criteria, notes, priority, type, and
execution contract. Changing a stable ID is represented as one removed task and one added task; IDs are
not matched by title.

Atelier stores the plan content hashes plus fixed-size structural hashes rather than a second unrestricted
copy of the Markdown document.

## Blocking diagnostics

- No task headings.
- Duplicate task IDs.
- Malformed JSON metadata.
- Metadata ID not matching the heading ID.
- Missing or malformed execution contract.
- Absolute, parent-escaping, non-source, or empty write scope.
- Unknown named validation.
- Dependency manifest named while dependency changes are false.
- Full validation named while the full-suite constraint is false.
- No named configured required validation when closure requires one.
- Missing completion criteria.
- Self-dependency.
- Unknown dependency.
- Dependency cycle.

Missing goal and human-readable validation sections remain warnings, but the execution contract is
mandatory.

## Exact review and approval

A parsed revision is not executable merely because it is valid. Atelier requires a completed `ManualEdit`
for the exact current content hash. Preparation then binds that reviewed hash to:

- task-provider identity and version;
- deterministic reconciliation digest and complete operation preview;
- primary source baseline;
- every approved workspace repository source binding;
- retrieval provider/index bindings used by planning; and
- the complete multi-task reviewed-constraint projection and digest.

CLI automation supplies the explicit transaction identity:

```sh
atlr plan prepare --json
atlr approve --approval <id> --digest <digest> --yes
```

Pi `/approve` displays the same plan hash, provider, reconciliation operations, retirements, proposed first
task, exact paths, named validations, optional dependency/full-suite/local-change authority, and explicit
exclusions before confirmation.

Rejection records the decision and performs zero provider mutation. Any plan, provider, reconciliation,
source, workspace, retrieval, reviewed-constraint, or concurrent-execution drift invalidates the prepared
transaction.

## Reconciliation

Reconciliation supports:

- adopting one uniquely marked provider task;
- creating a missing provider task;
- updating mapped title, description, design notes, acceptance criteria, priority, and type;
- adding and removing managed dependency relationships;
- retiring a mapped task removed from the reviewed plan by closing it with an explicit reason; and
- surfacing ambiguous identity, unsupported task constraint, provider drift, and unexpected edits as conflicts.

Every provider task retains `Atelier plan task: <stable-id>` in its notes. Mappings and operation
checkpoints make reconciliation idempotent across restart, including a crash after provider creation but
before mapping persistence. Retired tasks are closed, not deleted. Atelier does not rewrite the reviewed
plan from provider status changes.

After approval, the plan remains the reviewed scope baseline while the provider owns task status and
dependency readiness. Material scope changes require another ManualEdit and exact transaction. Closing one
task exposes later approved-plan ready work but never starts it automatically.
