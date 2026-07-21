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

## Reconciliation

Reconciliation currently supports:

- Creating missing provider tasks.
- Updating mapped task title, description, design notes, acceptance criteria, priority, and type.
- Adding missing dependency relationships.

It intentionally does not close or delete provider tasks merely because a user removed them from a plan. That requires an explicit lifecycle policy and review workflow in a later iteration.
