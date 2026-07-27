# Local Acceptance Workflow

This is the final maintainer gate for the delivered Atelier workflow. Automated acceptance is portable and mandatory; the interactive Jujutsu-first walkthrough is manual because it intentionally uses a real TUI, configured editor, and locally available optional providers.

## Automated evidence

Run from the Atelier checkout:

```sh
node --no-warnings --experimental-strip-types --test tests/acceptance-workflow.test.ts
node --no-warnings --experimental-strip-types --test tests/smoke-cleanup.test.ts
bash scripts/smoke.sh
mise run check
```

The end-to-end fixture verifies semantic state rather than generated IDs, timestamps, or temporary paths. It uses:

- a temporary Git compatibility repository;
- a foreground editor process that directly rewrites the plan;
- a persistent fake Beads CLI and provider task state;
- configured focused validation;
- a fake Pi TUI lifecycle where real terminal automation is impractical.

It covers `ManualEdit`, structural diff, create/update/link/unlink/retire preview, rejection with zero provider mutation, exact approval, task claim, independent operation permission, post-tool evidence, current/stale/rerun validation, shutdown/resume without duplicate tasks, cancellation, and final Working State reconstruction.

`scripts/smoke.sh` explicitly selects Git, disabled code intelligence, and temporary local state. `tests/smoke-cleanup.test.ts` proves its temporary repository is removed after success, forced failure, and process-group cancellation.

## Disposable Jujutsu-first setup

Do not run the live walkthrough against the primary workspace or clean any existing state. Start from the committed revision in a disposable local clone:

```sh
acceptance_parent="$(mktemp -d -t atelier-live-acceptance.XXXXXX)"
git clone --no-hardlinks . "$acceptance_parent/atelier"
cd "$acceptance_parent/atelier"
jj git init --colocate
mise install
mise run install
```

Inspect before initializing anything:

```sh
jj status
atlr doctor
atlr repo status
bd where --json || true
```

If and only if this disposable clone has no Beads state, initialize it explicitly:

```sh
atlr init --beads
```

Do not remove or recreate existing `.atelier`, `.beads`, codesearch, or Octocode state. Record unavailable optional integrations as unavailable; do not represent mock conformance as a live result.

## Interactive walkthrough

Start the supported shell:

```sh
mise run launch
```

### 1. Plan and provider-first investigation

Run:

```text
/plan add one tiny documented acceptance fixture change
```

Verify:

- the agent begins with one focused `atlr_code_search`;
- exact unresolved identifiers alone use `atlr_code_symbols`;
- returned paths are read directly;
- broad raw scanning occurs only after an explicit unavailable/degraded/failed/empty result;
- planning modifies only `.atelier/PLAN.md`.

### 2. Foreground `ManualEdit`

When the draft settles, verify Pi suspends and opens the configured editor automatically. Directly add, remove, reorder, or change one task/dependency; save and exit.

Verify Pi resumes cleanly and displays:

- before/after plan hashes;
- structural additions, removals, reordering, and field changes;
- parser diagnostics;
- provider identity and reconciliation digest;
- create/update/link/unlink/retire operations and conflicts;
- proposed first task.

Do not describe the editor changes again in chat.

### 3. Reject, then approve exactly

Run `/approve`, inspect the full transaction, and reject it once. Verify with `/status`, `/state`, and provider inspection that:

- mode remains `plan`;
- no execution grant exists;
- provider task content, dependencies, and count did not change.

Run `/approve` again against the unchanged reviewed revision and confirm. Verify:

- reconciliation converges;
- no duplicate provider task exists;
- the first approved-plan ready task is claimed;
- mode is `act`;
- Working State shows one active task/workspace-scoped execution grant;
- the grant conveys no file or other action permission.

### 4. Mutation evidence and validation freshness

Allow one bounded source mutation when prompted. Verify `/state` records the mutating tool outcome, before/after repository identity, observed mutation, and changed paths without touching any pre-existing change.

Run:

```text
/validate plan
/validate focused
/evidence
/state
```

Verify the focused selection gives reasons, only focused permission is requested, and the pass is current.

Perform one further authorized source change. Verify `/evidence` and `/state` show the old pass as stale, not current. Run `/validate focused` again and verify the new pass is current.

### 5. Restart and explicit continuation

Quit Pi while the task remains active, then restart:

```sh
mise run launch
```

Run `/status` and `/state`. Verify task, plan approval, reconciliation, active execution grant, mutation evidence, and validation freshness reconstruct without relying on an LLM summary.

Run `/cancel acceptance cancellation`. Verify execution and linked permissions are revoked while repository and provider task content remain intact.

If another approved task is ready after explicit closure/deferment of the current task, run `/execute <task-id>`, reject once, then confirm. Verify no new task-scoped grant is issued before confirmation.

## Evidence record

Record the live run in the implementing Beads task notes with:

- exact commit;
- operating system and terminal/TMUX context;
- Pi, Jujutsu, Beads, and codesearch versions/status;
- editor used;
- observed pass/failure for each numbered section;
- any unavailable optional integration;
- confirmation that the disposable clone was removed.

Never claim live acceptance from the fake-provider fixture. If this session has no interactive TTY or lacks permission to create a disposable clone, record the manual gate as pending and ask the maintainer to run this checklist.

Cleanup only the disposable clone after preserving the evidence:

```sh
cd /
rm -rf "$acceptance_parent"
```
