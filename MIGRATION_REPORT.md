# Migration Report — v0.13.0

## Summary

Atelier migrates the repository-local SQLite ledger automatically on open. The current schema adds durable retrieval sessions, exact plan approvals/reconciliation transactions, execution and permission grants, mutating-tool evidence, and focused-validation selection/evidence while preserving prior workflow and `ManualEdit` records.

No manual import, task recreation, provider reindex, or plan conversion is required.

## Preserve these assets

Do not remove, recreate, clean, or import over:

- `.atelier/PLAN.md` — the reviewed human scope artifact;
- `.atelier/atelier.db` (or configured `databasePath`) — approvals, mappings, grants, evidence, and restart state;
- `.beads/` and the configured `TaskProvider` state — task status and dependency authority;
- `.codesearch.db`, configured codesearch service state, or Octocode indexes — provider-owned retrieval state;
- `.atelier/config.json`, `.atelier/workspace.json`, and `.atelier/validation.json`;
- legitimate tracked or untracked working-copy changes;
- Jujutsu changes, operation history, workspaces, and bookmarks.

`.beads/issues.jsonl` remains a passive Beads export, not the normal synchronization or migration protocol. Do not run `bd import` as an Atelier upgrade step.

## Command changes

Direct reconciliation mutation and direct task claim are no longer supported workflow paths.

Old or unsafe forms:

```sh
atlr plan reconcile --apply
atlr task claim <id>
atlr approve --approval <id>
```

Current exact forms:

```sh
atlr review
atlr plan prepare --json
atlr approve --approval <id> --digest <reconciliation-digest> --yes
atlr task start [id] --yes
# equivalent later-task command
atlr execute [id] --yes
atlr cancel --reason "operator stopped execution"
```

`atlr plan reconcile` is preview-only. Interactive CLI approval may confirm after displaying the exact transaction; non-interactive approval requires ID, digest, and `--yes`.

Pi adds `/execute [task-id]` and `/cancel [reason]`. `/approve` displays the full plan hash, provider identity, operation details, retirements, and proposed first task. `/validate plan` persists and displays an explainable focused selection; `/validate focused` runs only those checks with the independent focused-validation permission.

## Restart procedure

1. Finish or interrupt any running command without deleting state.
2. Exit the old Pi process so it releases SQLite and provider processes.
3. Update the checkout without cleaning legitimate working-copy changes.
4. Run the normal automated checks.
5. Restart through the supported entry point:

   ```sh
   mise run launch
   ```

6. Run `/status` and `/state`.

A valid active execution resumes only when plan hash, provider identity, reconciliation, repository/workspace identity, task mapping, and in-progress task status remain valid. Drift revokes or invalidates the grant and returns to plan mode. Atelier never silently preserves an invalid execution.

A fresh Pi session reconstructs authoritative state from SQLite, the repository, and the task provider. Conversation history, Pi custom entries, and compaction summaries are not migration inputs.

## Existing active work

- A valid task-scoped execution grant resumes with its linked permissions and evidence.
- A revoked or invalidated grant remains non-active.
- `/cancel` leaves the provider task in progress; resume it only through a fresh exact transaction, or explicitly close/defer it in the provider.
- Explicit task closure revokes the prior grant and exposes later approved-plan ready work without starting it.
- Validation passes remain current only for an exact matching repository fingerprint. Expect a focused rerun after relevant source changes.
- Pending mutating-tool evidence is marked interrupted during Pi shutdown rather than promoted to success.

## Provider behavior

Codesearch remains the default Code provider. Existing provider indexes are not parsed, rewritten, or migrated by Atelier. Repository or index revision drift invalidates affected retrieval evidence; it does not require deleting the index. Octocode remains optional and capability-gated.

Beads remains the default `TaskProvider`, invoked through its public JSON CLI. Atelier never mutates Beads database tables directly.

## Validation after upgrade

Automated portable checks:

```sh
node --no-warnings --experimental-strip-types --test tests/acceptance-workflow.test.ts
node --no-warnings --experimental-strip-types --test tests/smoke-cleanup.test.ts
bash scripts/smoke.sh
mise run check
```

The ordinary suite requires no live Pi, Beads, Jujutsu, codesearch, Octocode, or network access. Complete the optional live-maintainer gate from a disposable Jujutsu workspace using `docs/LOCAL_ACCEPTANCE.md`; never use the primary workspace as test data.
