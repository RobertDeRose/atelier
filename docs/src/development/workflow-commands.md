# Workflow

Atelier uses the dstack documentation-first and Beads-backed workflow. The
project keeps feature intent in `docs/src/features/<slug>/design.md`, live
execution state in Beads, implementation evidence in code and tests, and
reconciled delivery history in each feature's `index.md`.

## Project workflow

Use the lifecycle in this order:

1. **Plan** a feature and resolve the decisions needed to implement it.
2. **Start** the feature after its design and dependency graph are reviewed.
3. **Implement** one ready task at a time, keeping code, tests, docs, and
   validation evidence aligned.
4. **Close** the feature by reconciling delivered behavior with its design and
   reader-facing documentation.
5. **Audit** periodically for drift between Beads, docs, tests, and code.

The project uses these commands:

```text
/plan-features
/start-feature <slug>
/implement-feature <slug>
/implement-task <task-selector>
/close-feature <slug>
/audit-project
```

Beads remains the live authority for status, dependencies, claims, blockers,
and ready work:

```sh
bd prime
bd ready --json
bd show <id>
```

## Feature documentation

Each planned feature has a slug-scoped `design.md`. Each delivered feature has
an `index.md` that stands alone and records capability, validation, deferred
work, and audit evidence. The [Planned Features](../planned-features.md) page
is a human roadmap; it is not a replacement for Beads.

## More detail

The workflow implementation is maintained by the
[dstack project](https://github.com/RobertDeRose/dstack). Use its current
workflow documentation for lifecycle semantics and template updates; this
page records only how Atelier applies that workflow.
