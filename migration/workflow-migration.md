<!-- rumdl-disable MD013 -->

# Legacy Workflow Migration Report

Generated: `2026-08-04T04:12:44+00:00`

## Inventory

- Features: 0
- Legacy task files: 0
- Parsed task files: 0
- Unparsed task files: 0
- Parsed legacy tasks: 0
- Reconciliation findings: 0

## hk Reconciliation

- Baseline status: `absent`
- Current status: `evaluable`
- Recorded dispositions: 0
- Blocking inventory issues: 0

## Artifact Lifecycle

- Temporary candidates present: False
- Conditional backup present: False
- Backup disposition: `not_applicable`
- Backup disposition reason: —

## Checkpoint Evidence

- No checkpoint evidence recorded.

## Feature Mapping

## Reconciliation Findings

## Migration Stages

1. Review this report and confirm the feature slug mapping.
2. Use `classify` and `resolve-findings` to record evidence-backed decisions before import.
3. Run `prepare --apply` to rename feature paths and rewrite links.
4. Run `import-beads --apply` to create Beads state.
5. Use `/migrate-workflow` to reconcile designs, delivered records, and status conflicts.
6. Run `finalize --apply` only after no page includes or links to `tasks.md`.
7. Run `verify --beads` and the normal project checks.
