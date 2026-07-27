# Atelier Plan Format, Version 1

An Atelier plan is valid Markdown. Machine metadata is intentionally limited to comments directly below task headings.

## Required structure

Each task starts with either:

````markdown
## ATLR-001 — Task title
````

or:

````markdown
## [ATLR-001] Task title
````

Optional metadata follows:

````markdown
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task"} -->
````

Supported task types are `bug`, `feature`, `task`, `epic`, and `chore`. Priorities are integers from `0` through `4`, where a lower number is selected first by the in-memory provider.

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
description, scope, exclusions, dependencies, validation, completion criteria, notes, priority, and
type. Changing a stable ID is represented as one removed task and one added task; IDs are not matched
by title. Atelier stores the plan's content hashes plus fixed-size hashes of these structural fields,
not a second unrestricted copy of the Markdown document.

## Blocking diagnostics

- No task headings.
- Duplicate task IDs.
- Malformed JSON metadata.
- Metadata ID not matching the heading ID.
- Missing completion criteria.
- Self-dependency.
- Unknown dependency.
- Dependency cycle.

Missing goal and validation sections are warnings in version 1.

## Exact review and approval

A parsed revision is not executable merely because it is valid. Atelier requires a completed `ManualEdit` for the exact current content hash. Preparation then binds that reviewed hash to the `TaskProvider` identity, repository/workspace identity, deterministic reconciliation digest, and complete operation preview.

CLI automation must supply all three explicit values:

```sh
atlr plan prepare --json
atlr approve --approval <id> --digest <digest> --yes
```

Pi `/approve` displays the same full plan hash, provider, operations, retirements, and proposed first task before confirmation. Rejection records the decision and performs zero provider mutation. Any plan, provider, reconciliation, repository, workspace, or concurrent-execution drift invalidates the prepared transaction.

## Reconciliation

Reconciliation supports:

- adopting one uniquely marked provider task;
- creating a missing provider task;
- updating mapped title, description, design notes, acceptance criteria, priority, and type;
- adding and removing managed dependency relationships;
- retiring a mapped task removed from the reviewed plan by closing it with an explicit reason; and
- surfacing ambiguous identity, unsupported capability, provider drift, and unexpected edits as conflicts.

Every provider task retains `Atelier plan task: <stable-id>` in its notes. Mappings and operation checkpoints make reconciliation idempotent across restart, including a crash after provider creation but before mapping persistence. Retired tasks are closed, not deleted. Atelier does not rewrite the reviewed plan from provider status changes.

After approval, the plan remains the reviewed scope baseline while the provider owns task status and dependency readiness. Material scope changes return to `ManualEdit` and exact reconciliation. Closing one task exposes later approved-plan ready work but never starts it automatically.
