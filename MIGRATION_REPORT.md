# Migration Report — Atelier 0.14.0-alpha.8

## Summary

Atelier 0.14.0-alpha.8 introduces no ledger, plan, trust, or provider-state migration beyond alpha.6. It does introduce clearer closure-policy configuration: new manifests use `requireCleanSource` and `requireCleanRepository`; the legacy `requireCleanGit` field remains accepted and maps to both settings.

The alpha.6 migration boundary remains in force. Migration 8 is applied automatically, but alpha.5 plan
tasks did not contain the structured execution contract needed to derive exact path and validation
capabilities. Existing project documents, task mappings, provider task state, trust records, retrieval
history, and workflow history are preserved, but an alpha.5 plan must be updated and reviewed again before
a new alpha.6-or-later approval can execute it.

Active alpha.5 execution grants fail closed because their static broad capability bundle cannot be treated
as the exact alpha.6 contract. Exit the old Pi process, back up the external runtime state, upgrade, add
execution metadata to the plan, run review, and approve a fresh transaction. Atelier does not fabricate a
narrow contract from prose or reactivate a legacy broad grant.

## Required upgrade steps

```sh
mise install
mise run install
npm run build
atlr trust status
atlr config validate
```

Trust remains explicit and external to the repository. Review `.atelier/config.json`,
`.atelier/validation.json`, and `.atelier/workspace.json` before trusting a repository because trust permits
their configured providers, validators, and editor command to execute.

For every plan task, add an exact execution object to `atlr:task` metadata, for example:

```markdown
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["src/example.ts","tests/example.test.ts"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->
```

Then run:

```sh
atlr review
atlr plan prepare --json
atlr approve
```

Preparation rejects missing execution metadata, unknown validations, dependency paths without explicit
dependency permission, full-suite validation without a named full check, and non-source/out-of-root paths.
The approval display now lists the effective paths, validations, dependency permission, local-change
scope, task closure, and exclusions before mutation.

## Pi behavior changes

- Incomplete active tasks may remain idle or paused. `agent_settled` never schedules a follow-up turn.
- `/atelier-stop` stops the current turn without revoking execution. `/atelier-pause` durably disables
  agent mutation, and `/atelier-resume` restores it without starting a model turn.
- `/cancel` revokes execution without waiting for idle and atomically records a cancelled workflow while
  preserving the provider task and working-copy changes.
- The model now receives typed `atlr_state`, `atlr_validate`, `atlr_commit`, and `atlr_task_close` tools.
  Existing human status, validation, commit, and close commands remain available.
- Explicit user prohibitions such as “do not use Bash”, “do not validate”, “do not commit”, or “do not
  close” are enforced as a temporary turn policy before an exceptional approval prompt. “Stop after”
  remains a current-turn instruction; `/atelier-stop` is the enforceable active-turn control.
- Explicit `/code-symbols` and CLI symbol requests are direct lookups. The autonomous model tool remains
  inventory-gated.
- Failed tool output that merely mentions `signal`, `abort`, or `cancel` is no longer classified as
  interrupted.
- Exact known paths may be read directly; provider-first semantic discovery remains advisory.

The ledger migration is automatic. Plan review and fresh exact approval are required when moving an
alpha.5 execution workflow to the alpha.6 capability model.

## Pi command migration

Pi reserves `/trust` for Pi-owned project-resource trust. Atelier 0.14.0-alpha.3 therefore renames its
interactive command to `/atelier-trust`. The CLI remains `atlr trust ...`; no trust-store migration is
required.

## Runtime-state move

New runtime state defaults to:

```text
${XDG_STATE_HOME:-~/.local/state}/atelier/repositories/<root-hash>/atelier.db
```

Repository configuration cannot override the runtime directory or database path. A user-level config or
`ATLR_STATE_HOME` can do so. Existing repository-local `.atelier/atelier.db` is not imported
automatically; preserve it as a backup and explicitly place/copy it at the externally configured
`databasePath` only when its provenance is trusted.

Project files remain under `.atelier/` and are now intentionally trackable:

- `.atelier/PLAN.md`;
- `.atelier/config.json`;
- `.atelier/validation.json`;
- `.atelier/workspace.json`.

## Authorization migration

- Grant scopes are now only `operation`, `task`, and `repository`.
- Migration 7 revokes legacy `turn` and `session` grants.
- Legacy execution/approval records without the alpha.6 structured task contract fail closed on resume and
  require plan metadata migration, ManualEdit review, and fresh preparation/approval.
- Exact approval installs only reviewed path, named validation, optional dependency, optional local-change,
  and task-close capabilities. Task update/link and full-suite permissions are not implicit.
- The complete capability projection is displayed and hashed into the approval transaction.
- Generic shell never inherits those capabilities and requires one-operation approval.
- A project must be trusted before execution, provider startup, validation, editor launch, or indexing.
- Pause and cancellation update workflow state atomically; execution revalidation is idempotent.

No migration should infer an execution contract from prose, fabricate a capability digest, or reactivate a
revoked legacy grant.

## Validation migration

The obsolete validation field `approval` is rejected. Remove it from `.atelier/validation.json`.
Authorization is controlled by Atelier policy and capabilities.

When `closurePolicy.requireValidation` is true, configure at least one applicable check with
`required: true`; otherwise `atlr config validate` and task closure fail. A missing focused selection is
now reported separately from a manifest with no required validation. Current closure can also require:

- exact final-diff review;
- a local Git commit or finalized Jujutsu change;
- a clean repository state.

Prior validation evidence can become stale after repository, command, environment, platform, runtime, or
lockfile drift.

## Multi-repository migration

Every secondary root in `.atelier/workspace.json` requires an external approval:

```sh
atlr trust workspace add /absolute/path/to/repository --yes
```

Unapproved roots are rejected. Each approved root receives a real repository snapshot; secondary drift
invalidates exact execution and retrieval reuse.

## Provider and diagnostic behavior

Repository provider command failures are no longer interpreted as clean state. Diagnose them explicitly.
`atlr doctor` no longer opens the ledger or starts providers, so use `atlr repo status`, `atlr code doctor`,
or provider-native commands after trust for live checks.

Provider-first retrieval is advisory. Existing provider indexes remain provider-owned and can be reused
when their source/index bindings are current. Source freshness excludes `.atelier`, Beads, and provider
metadata churn while raw VCS identity remains available for diagnostics. Symbol display signatures are
normalized on read; no index rebuild is required solely for alpha.6.

`atlr init --beads` is now idempotent: an initialized provider is preserved and only directory permission
hardening is applied. It does not implicitly rerun destructive provider initialization.

## Rollback

Back up the external runtime directory before opening it with this release. A rollback must not restore
legacy grants as active. Preserve project documents, task-provider state, VCS state, and provider indexes;
do not delete or recreate them merely to make an old binary accept the workspace.

## Alpha.8 closure-policy migration

New manifests should replace `requireCleanGit` with:

```json
{
  "requireCleanSource": true,
  "requireCleanRepository": true
}
```

`requireCleanGit` remains accepted as a compatibility alias and maps to both fields. No ledger migration is required. When whole-repository cleanliness is enabled, typed closure creates a separate local workflow-metadata commit/change after the scoped implementation change and before successful completion is recorded.
