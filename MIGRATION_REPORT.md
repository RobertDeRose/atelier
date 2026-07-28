# Migration Report — Atelier 0.14.0-alpha.5

## Summary

No runtime data migration is required from 0.14.0-alpha.4. This patch release isolates the
deterministic test harness from workstation Git configuration, relaxes fake-provider test deadlines,
and improves Octocode timeout diagnostics.

This release intentionally tightens trust, authorization, runtime-state, validation, and exact-approval
semantics. SQLite schema migration 7 is automatic. Existing plans, task mappings, provider task state,
retrieval evidence, and workflow history remain readable, but unsafe legacy authorization is not carried
forward.

## Required upgrade steps

```sh
mise install
mise run install
npm run build
atlr trust status
atlr trust add --yes
atlr config validate
```

Trust is now explicit and stored outside the repository. Review `.atelier/config.json`,
`.atelier/validation.json`, and `.atelier/workspace.json` before trusting a repository because trust
permits their configured providers, validators, and editor command to execute.

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
- Legacy execution/approval records without an exact capability digest fail closed on resume and require
  a fresh plan preparation and approval.
- Exact approval atomically installs typed task capabilities.
- Generic shell never inherits those capabilities and requires one-operation approval.
- A project must be trusted before execution, provider startup, validation, editor launch, or indexing.

No migration should fabricate a capability digest or reactivate a revoked legacy grant.

## Validation migration

The obsolete validation field `approval` is rejected. Remove it from `.atelier/validation.json`.
Authorization is controlled by Atelier policy and capabilities.

When `closurePolicy.requireValidation` is true, configure at least one applicable check with
`required: true`; otherwise `atlr config validate` and task closure fail. Current closure can also require:

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
when their source/index bindings are current.

## Rollback

Back up the external runtime directory before opening it with this release. A rollback must not restore
legacy grants as active. Preserve project documents, task-provider state, VCS state, and provider indexes;
do not delete or recreate them merely to make an old binary accept the workspace.
