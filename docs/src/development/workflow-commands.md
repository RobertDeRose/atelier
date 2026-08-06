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

## Core lifecycle boundary

The Core `dstack` coordinator resolves a feature root and its parent-child
Beads graph on every inspection; it does not copy task state into the ledger.
`startFeature` and `closeFeature` require explicit confirmation, while
`prepareImplementation` selects a ready child without claiming it or granting
repository mutation. The existing exact execution workflow remains responsible
for task scope and execution grants.

Pause and recovery preserve the feature id and provider state. Recovery requires
an explicit resume decision; no startup or inspection call resumes mutation.
`auditFeature` is observational, and feature closure requires all child work to
be closed or deferred plus current review and repository quality-gate evidence.
The CLI and Pi adapter workstream will call these Core-owned transitions rather
than claiming or closing Beads issues directly.

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
