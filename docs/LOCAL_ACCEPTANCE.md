# Local Acceptance Workflow — 0.14.0-alpha.45

This is the maintainer gate for Atelier's workspace-bound plan-to-commit workflow. The deterministic suite is
mandatory. Live acceptance is separate because it depends on installed Jujutsu, Beads, codesearch, Pi,
and a terminal.
The in-tree guided verifier is regression-tested under Bash `set -u` so each manual step resolves its workspace and evidence paths before launching Pi. Generated guides use literal Markdown backticks, starting `guided` refreshes corrected instructions without resetting existing workspaces or results, and `retry STEP` recreates only the selected failed disposable workspace. Every launch records Pi stderr and exit status, and unexpected failures remain visible instead of being cleared.

## Deterministic gate

```sh
mise install
mise run install
npm run check
# `npm run check` includes the symlinked-TMPDIR canonical-path lane.
npm pack --dry-run
```

The suite covers startup-workspace selection, recoverability policy, sandboxed shell execution, real-path confinement, smoke success/failure/cancellation cleanup with load-tolerant child-process synchronization, structured task execution
constraints, exact constraint disclosure, exact approval and rejection, passive incomplete-task handling,
stop/pause/resume/cancel control, typed model workflow tools, per-turn hard tool restrictions, accurate
failure/interruption and per-operation path evidence, source-only freshness, scoped commits, idempotent
Beads initialization, symbol-state convergence, validation staleness, exact diff review, restart,
multi-repository drift, live footer model/thinking selection, Git/Jujutsu refresh scheduling, source-qualified
intelligence degradation, external idle drift refresh, macOS/symlink repository-path canonicalization,
in-flight observation invalidation, canonical-root test expectations under a symlinked temporary directory, model Bash streamed/final lifecycle completion, single-line idle progress and native streaming phases, immediate pause/resume/cancel footer evidence,
external codesearch selection-state migration, bounded Jujutsu transient-snapshot retry, readable multiline task metadata,
direct-read planning for exact file-scoped objectives, compact evidence archives, and package metadata.

Fixture conformance is deterministic evidence only. Do not describe it as a live external-provider run.

## Persistent live workspace

Never perform the live gate in the primary checkout. Use a persistent clone so reboot does not destroy
evidence.

```sh
cd /path/to/atelier

manual_root="$HOME/workspace/scratch/atelier-manual-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$manual_root"
git clone --no-hardlinks . "$manual_root/repo"
printf '%s\n' "$manual_root" > "$HOME/.atelier-manual-current"

cat > "$manual_root/env.sh" <<EOF_ENV
export ATELIER_MANUAL_ROOT="$manual_root"
export ATLR_REPO="$manual_root/repo"
export ATLR_STATE_HOME="$manual_root/state"
export ATLR_USER_CONFIG="$manual_root/user-config.json"
export VISUAL="\${VISUAL:-hx}"
export EDITOR="\${EDITOR:-\$VISUAL}"

atlr() {
  (
    cd "\$ATLR_REPO"
    mise exec -- node "\$ATLR_REPO/bin/atlr.mjs" "\$@"
  )
}
EOF_ENV

source "$manual_root/env.sh"
cd "$ATLR_REPO"
mise install
mise exec -- jj git init --colocate
mise run install
```

Resume after reboot or in another terminal:

```sh
manual_root="$(cat "$HOME/.atelier-manual-current")"
source "$manual_root/env.sh"
cd "$ATLR_REPO"
mise install
mise exec -- jj status
```

Record the source and tools:

```sh
{
  printf 'Repository: %s\n' "$ATLR_REPO"
  printf 'HEAD: %s\n' "$(git rev-parse HEAD)"
  printf 'Atelier: %s\n' "$(atlr --version)"
  for tool in node jj bd codesearch pi; do
    command -v "$tool" >/dev/null && printf '%-12s %s\n' "$tool" "$($tool --version 2>&1 | head -1)"
  done
} | tee "$ATELIER_MANUAL_ROOT/tool-versions.txt"
```


## Interactive latency checks

In Pi, run `/performance clear`, then run `/status` twice, `/workflow`, and `/performance`.

Pass conditions:

- each idle command displays one animated Atelier progress line before repository/provider work begins, without replacing durable footer mode;
- the second `/status` reuses the recent repository observation when no source mutation occurred;
- default `/workflow` does not initiate semantic retrieval or a code-provider refresh;
- `/workflow full` remains available for explicit authoritative reconstruction;
- the performance report contains `/status/total`, `repository.observe`, cache, subprocess, hashing, and SQLite summaries;
- an approved tool begins without waiting for a complete footer observation; and
- an operation requiring a recovery checkpoint prompts first, then visibly reports checkpoint creation after approval.

The performance report is diagnostic rather than a security decision. Exact approval, tool authorization, and
closure continue to force the current observations required by their authority boundaries.

## 1. Observational diagnostics and workspace selection

```sh
find .atelier -type f -print 2>/dev/null | LC_ALL=C sort > "$ATELIER_MANUAL_ROOT/files-before-doctor.txt"
atlr doctor | tee "$ATELIER_MANUAL_ROOT/doctor.json"
find .atelier -type f -print 2>/dev/null | LC_ALL=C sort > "$ATELIER_MANUAL_ROOT/files-after-doctor.txt"
diff -u "$ATELIER_MANUAL_ROOT/files-before-doctor.txt" "$ATELIER_MANUAL_ROOT/files-after-doctor.txt"
test ! -e "$ATLR_STATE_HOME"
```

Pass conditions: `doctor` is observational, reports the canonical startup directory as the workspace, creates no project or runtime state, and requires no Atelier trust setup. Pi `/trust` remains available only for Pi project-local resources.

## 2. Initialize and establish a clean baseline

```sh
atlr init --beads | tee "$ATELIER_MANUAL_ROOT/init.json"
find .beads -type f -exec shasum -a 256 {} + | LC_ALL=C sort > "$ATELIER_MANUAL_ROOT/beads-before-second-init.sha256"
atlr init --beads | tee "$ATELIER_MANUAL_ROOT/init-second.json"
find .beads -type f -exec shasum -a 256 {} + | LC_ALL=C sort > "$ATELIER_MANUAL_ROOT/beads-after-second-init.sha256"
diff -u "$ATELIER_MANUAL_ROOT/beads-before-second-init.sha256" "$ATELIER_MANUAL_ROOT/beads-after-second-init.sha256"
bd where --json | tee "$ATELIER_MANUAL_ROOT/beads-where.json"
bd list --json | tee "$ATELIER_MANUAL_ROOT/beads-before-plan.json"
test "$(stat -f '%Lp' .beads 2>/dev/null || stat -c '%a' .beads)" = 700

test ! -e .atelier/atelier.db
find "$ATLR_STATE_HOME" -name atelier.db -print
```

Configure one small required validation:

```sh
cat > .atelier/validation.json <<'JSON'
{
  "closurePolicy": {
    "requireValidation": true,
    "requireFinalDiffReview": true,
    "requireLocalChange": true,
    "requireCleanSource": true,
    "requireCleanRepository": true
  },
  "validations": {
    "manual-acceptance": {
      "command": [
        "node",
        "--no-warnings",
        "--experimental-strip-types",
        "--import",
        "./tests/test-environment.ts",
        "--test",
        "tests/version.test.ts"
      ],
      "category": "focused",
      "focused": true,
      "required": true,
      "paths": [
        "packages/core/src/version.ts",
        "tests/version.test.ts"
      ]
    }
  }
}
JSON

atlr config validate --json | tee "$ATELIER_MANUAL_ROOT/config-validation.json"
jj status
jj diff --stat
```

There must be no changes under `apps/`, `packages/`, or `tests/` yet. Commit setup separately:

```sh
jj commit -m "test: establish Atelier manual acceptance baseline"
jj status
jj log -r @- --no-graph -T 'commit_id ++ "\n"' > "$ATELIER_MANUAL_ROOT/setup-baseline-commit.txt"
```

## 3. Verify the shell boundary

These commands classify policy only; they do not execute the payload:

```sh
atlr policy command 'env rm -rf build'
atlr policy command 'git tag v1.0.0'
atlr policy command 'cat <(rm -rf build)'
atlr policy command 'sed --in-place s/a/b/ src/file.ts'
```

Every decision must be `ask` with a concrete unrecoverable consequence. Read-only commands that the
effect analyzer can bound may be allowed, but these destructive or indeterminate examples must never be
silently authorized by an active task or by sandbox availability alone.

## Persistent report presentation

Before continuing, run `/status`, `/workflow`, and `/code-status` in sequence. Each result must remain visible
in transcript scrollback after the next command. `/status` and `/code-status` should render expandable report cards with bold field/value summaries;
`/workflow` should render a concise ledger/status-only workflow report and remain distinguishable from `/status`; use `/workflow full` only for explicit provider-backed reconstruction. A workspace configured with `codeProvider: "disabled"` must show
`intel: disabled`, not `offline`.

For a guided, evidence-gathering walkthrough that clears each terminal transition and identifies the
intentional VCS/provider state, run the full flow:

```sh
scripts/guided-verification.sh all /path/to/atelier
```

After `scripts/live-acceptance.sh` has already completed, continue the existing run with:

```sh
scripts/guided-verification.sh guided
```

The `guided` command checks every required workspace and guide and prepares them automatically when they are
missing. Running the script with no command only prints usage. Detailed manual instructions are written under
the persistent run's `guided/guides/` directory rather than left above the Pi viewport.

The guided objective checks also inspect bounded `ui.*` ledger events. A passing archive must prove:

- `/status` and `/workflow` produced distinct report digests;
- footer evidence observed Jujutsu/Git identity, code-intelligence readiness, and at least two thinking levels;
- `/status`, `/workflow`, `/plan`, and every exact-approval phase were presented on the single-line spinner or native working-indicator surface before their expensive work;
- the model Bash probe recorded start, streamed output, successful final completion, output bytes/hash, and no failure/interruption; and
- Pi reached an idle `ui.agent_settled` state after the model Bash result.

These events are diagnostic evidence only. They do not authorize effects, satisfy validation, or close a task.

## 4. Verify code intelligence

In Pi:

```text
/code-index
/code-status
/code-search Where is the authoritative task closure predicate implemented?
/code-symbols AtelierCore
```

Pass conditions:

- the index reaches `ready`;
- the closure query returns relevant Core implementation paths;
- an explicit human symbol request calls or reuses the symbol operation without requiring prior semantic
  unresolved state;
- `class AtelierCore` ranks first and points to `packages/core/src/core.ts`;
- inventory records canonical `AtelierCore`, not `class AtelierCore` or `block (N lines)`;
- `AtelierCore` is not simultaneously unresolved in the same repository scope;
- provider detail is concise and search results do not contain empty preview lines.

A separate unresolved marker in another repository scope is valid and must remain scope-qualified.

## 5. Plan, review, reject, and approve

In a fresh Pi session:

```text
/plan Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to packages/core/src/version.ts and add tests/version.test.ts verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. Do not change release metadata or any other behavior.
```

The planner must use the exact configured validation catalog. Inspect the generated plan without repairing
it manually. The plan should use one atomic task containing implementation and tests, and its task marker
must contain this reviewable execution contract (formatting/order may differ):

```json
{
  "writePaths": [
    "packages/core/src/version.ts",
    "tests/version.test.ts"
  ],
  "allowDependencyChanges": false,
  "validations": ["manual-acceptance"],
  "allowFullSuite": false,
  "allowLocalChange": true
}
```

The human-readable Validation and Completion sections must also name `manual-acceptance`, not an invented
`typecheck`, `test`, or `check` validation. If the generated plan differs, leave it unchanged and record the
planner failure; manually correcting it would hide the behavior under test.

Planning may change only `.atelier/PLAN.md`; Beads and product source must remain unchanged. Preparation
must fail when the execution contract is removed or names an unknown validation.

After automatic editor review, run `/status` and `/workflow`. Then run `/approve` and reject once. Verify
`bd list --json` remains empty and `atlr status --json` reports no active execution grant and zero reviewed
task constraints.

Run `/approve` again and inspect the unchanged transaction before accepting it. The dialog must disclose:

- writes only to `packages/core/src/version.ts` and `tests/version.test.ts`;
- dependencies not permitted;
- focused validation `manual-acceptance`;
- full suite not permitted;
- one local change limited to the two reviewed paths;
- task close only after the completion predicate;
- shell effects remain independently governed by workspace containment and exact recoverability;
- publication, external effects, and out-of-scope task paths are excluded.

Accept it. Verify exactly one Beads task is active and `atlr status --json` reports an active execution
grant plus one reviewed task constraint. Re-open `atlr plan parse --json` and verify the constraint still
names exactly the two write paths and `manual-acceptance`; no filesystem permission grants should exist.

## 6. Typed edits, denial, pause, and cancellation

Tell the model:

```text
Implement the active task using only Pi's typed read, edit, and write tools. Do not use Bash, do not run validation, do not commit, and stop after the two approved source changes.
```

Pass conditions: only `packages/core/src/version.ts` and `tests/version.test.ts` change, typed in-root edits
do not prompt, and the agent stops without validation.

Then ask for one exact Bash command and deny it:

```text
Use Bash to run exactly: printf 'shell-boundary-ok\n'
```

During the implementation turn, any model attempt to use Bash, validation, commit, close, or autonomous
continuation must be blocked before an approval dialog because that same user message prohibited it.
After the model settles, the outside-workspace Bash request above is a new turn and must request one
concrete approval; deny it. The command must not execute. A read-only `printf` without persistent output
should not prompt. After denial, Pi must become idle. Atelier may show
one passive incomplete-task warning, but it must not enqueue another turn or return to an endless
`Working...` loop. Pressing Escape must also end the current turn without forcing continuation.

Exercise the distinct controls in a separate active turn. After approval, perform one normal code-retrieval
operation first and verify it does not invalidate the untouched execution grant. Then run:

```text
/atelier-stop
/atelier-pause manual pause acceptance
```

While paused, send this exact model instruction:

```text
Using only the typed edit tool, add the exact line // pause-probe to packages/core/src/version.ts. Do not use Bash or any other tool.
```

The typed edit must be blocked and the file must not contain `// pause-probe`. Then run:

```text
/atelier-resume
/cancel manual user-control acceptance
```

Pass conditions: `/atelier-stop` aborts only the turn; `/atelier-pause` keeps the grant/task active but
denies agent mutation; `/atelier-resume` restores mutation without starting a model turn; `/cancel` does
not wait for idle, atomically records a cancelled workflow, revokes execution, preserves the
open/in-progress Beads task, and preserves repository changes. Retrieval-session or index drift observed
after approval must be recorded as provenance and must not independently revoke an untouched grant.

Use a separate run for cancellation if the remaining closure workflow is also being tested.

## 7. Typed validation, evidence, restart, and closure

For a non-cancelled active run, verify premature closure fails and the reason says that no focused
validation selection has been recorded rather than claiming no validation is configured.

The model-facing paths are:

```text
Use atlr_state to report the authoritative current workflow state.
Use atlr_validate to plan and run the focused validation.
```

The human path remains:

```text
/validate plan
/validate focused
/evidence
```

Declared validation must not request generic Bash approval. A failed test is recorded as `failed`; only
structured cancellation or the exact tool abort sentinel is `interrupted`.

Edit source after a passing validation and verify evidence becomes stale. Quit and relaunch Pi while the
task is active; approval, task constraints, changed paths, recovery state, and next action must reconstruct without
conversation history.

Complete the task either through typed model tools or the human commands:

```text
Use atlr_commit with message "test: add manual Atelier product-name acceptance".
Use atlr_validate to rerun the focused validation.
```

```text
/evidence
/review-diff
Use atlr_task_close with reason "completed and verified".
```

Inspect the raw VCS change before closure. `.atelier/PLAN.md`, Beads/provider metadata, and unrelated
pre-staged paths must not be part of the task commit/change. Mutation evidence for the source edit must
attribute only the path changed by that operation, not every path that was already dirty. Workflow
metadata-only edits must not stale source retrieval/validation evidence.

Closure succeeds only when validation is current, the exact baseline diff was reviewed, a path-scoped
local commit/change exists, and configured cleanliness holds. After closure, the execution grant is revoked, reviewed task constraints are inactive, and no later task starts automatically.

## 8. Optional boundary tests

In separate disposable runs, test:

- absolute typed writes outside the session workspace;
- typed writes through a symlink escaping the root;
- secondary-repository drift after exact approval;
- cancellation followed by explicit `/execute TASK_ID` recovery.

Every exceptional write requires separate approval or denial. Secondary drift must fail resume closed.

## Evidence report

Record each item as `PASS`, `FAIL`, or `STOP`:

```text
Version and clean source
Persistent workspace and reboot resume
Workspace doctor observational
Pi /trust independence
External runtime database
Beads 0700 directory and idempotent initialization
Generic shell boundary
Direct user-shell output renders without terminating Pi
Configured-editor and `/atelier-open` terminal round trip
Code index and semantic search, including preserved doctor/statistics diagnostics on failure
Explicit human symbol lookup
Canonical scoped symbol inventory
Plan-mode source protection
Approval rejection zero-mutation
Exact execution contract and constraint disclosure
Exact approval and reviewed task constraints
Typed edits without extra prompt
Per-turn no-Bash policy
Denied operation leaves agent idle
Stop/pause/resume/cancel while active
Typed state/validation/commit/close tools
Failure versus interruption evidence
Per-operation changed-path attribution
Source-only freshness across workflow metadata
Path-scoped commit excludes workflow metadata
Restart reconstruction
Validation staleness
Exact diff review
Authoritative closure
Execution revocation after closure
```
