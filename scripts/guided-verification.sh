#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

PROGRAM="$(basename "$0")"
POINTER_FILE="${ATELIER_ACCEPTANCE_POINTER:-$HOME/.atelier-manual-current}"
SOURCE_REPO=""
RUN_ROOT=""
GUIDED_ROOT=""
EVIDENCE_DIR=""
RESULTS_FILE=""
TUI_TERMINAL_DIRTY=0

log() { printf '\n==> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage:
  $PROGRAM all [SOURCE_REPO]
  $PROGRAM automated [SOURCE_REPO]
  $PROGRAM prepare
  $PROGRAM guided [STEP]
  $PROGRAM status
  $PROGRAM archive

Typical continuation after live acceptance:
  $PROGRAM guided

Commands:
  all        Run deterministic and automated gates, prepare guided workspaces,
             then walk through every manual TUI step.
  automated  Run deterministic and automated gates, then prepare manual workspaces.
  prepare    Recreate only the disposable guided workspaces for the current run.
  guided     Walk through manual steps 1-5; optionally start at STEP.
  status     Show current run, workspaces, and recorded manual outcomes.
  archive    Rebuild the combined evidence archive.

Environment:
  ATELIER_GUIDED_SKIP_CHECK=1  Skip mise run check when it already passed.
  ATELIER_GUIDED_KEEP_GOING=1  Preserve evidence and continue after a recorded FAIL.
USAGE
}

canonical_dir() { (cd "$1" && pwd -P); }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"; }

clear_screen() {
  if [[ -t 1 ]]; then printf '\033[2J\033[H'; fi
}

restore_terminal() {
  [[ "$TUI_TERMINAL_DIRTY" == 1 ]] || return 0
  if [[ -t 0 ]]; then stty sane 2>/dev/null || true; fi
  # Restore modes commonly left active by full-screen TUIs after forced exits.
  printf '\033[?1049l\033[?25h\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[<u' 2>/dev/null || true
  TUI_TERMINAL_DIRTY=0
}
trap restore_terminal EXIT INT TERM

load_run() {
  [[ -f "$POINTER_FILE" ]] || fail "no current acceptance run; run '$PROGRAM automated SOURCE_REPO' first"
  RUN_ROOT="$(<"$POINTER_FILE")"
  [[ -d "$RUN_ROOT" ]] || fail "acceptance run no longer exists: $RUN_ROOT"
  GUIDED_ROOT="$RUN_ROOT/guided"
  EVIDENCE_DIR="$RUN_ROOT/evidence"
  RESULTS_FILE="$EVIDENCE_DIR/manual-results.tsv"
  mkdir -p "$EVIDENCE_DIR"
}

write_env() {
  local root="$1" repo="$2"
  cat >"$root/env.sh" <<ENV
export ATELIER_MANUAL_ROOT="$root"
export ATLR_REPO="$repo"
export ATLR_STATE_HOME="$root/state"
export ATLR_USER_CONFIG="$root/user-config.json"
export VISUAL="\${VISUAL:-hx}"
export EDITOR="\${EDITOR:-\$VISUAL}"
ENV
}

configure_repo() {
  local repo="$1" provider="$2" task_provider="${3:-none}" code_provider="${4:-disabled}"
  mkdir -p "$repo/.atelier"
  cat >"$repo/.atelier/config.json" <<JSON
{
  "taskProvider": "$task_provider",
  "repositoryProvider": "$provider",
  "codeProvider": "$code_provider",
  "providerFirstRetrieval": "advisory"
}
JSON
}

prepare_intel_jj() {
  local root="$GUIDED_ROOT/intel-jj" repo="$GUIDED_ROOT/intel-jj/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
    mise install >/dev/null
    mise run install >/dev/null
  )
}

prepare_policy_git() {
  local root="$GUIDED_ROOT/policy-git" repo="$GUIDED_ROOT/policy-git/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    chmod 700 .beads 2>/dev/null || true
    mise install >/dev/null
    mise run install >/dev/null
    configure_repo "$ATLR_REPO" git none disabled
    mkdir -p manual-policy
    printf 'clean read\n' > manual-policy/clean-read.txt
    printf 'clean edit\n' > manual-policy/clean-edit.txt
    printf 'clean delete\n' > manual-policy/clean-delete.txt
    printf 'dirty original\n' > manual-policy/dirty-delete.txt
    printf 'manual-policy/ignored-delete.txt\n' >> .gitignore
    git add .atelier/config.json .gitignore manual-policy
    git -c user.name='Atelier Acceptance' -c user.email='atelier@example.invalid' -c commit.gpgSign=false commit --no-gpg-sign -m 'test: establish Git policy baseline' >/dev/null
    printf 'dirty uncommitted\n' >> manual-policy/dirty-delete.txt
    printf 'untracked contents\n' > manual-policy/untracked-delete.txt
    printf 'ignored contents\n' > manual-policy/ignored-delete.txt
    printf 'ACCEPTANCE_SECRET=must-not-read-without-approval\n' > .env.acceptance
    printf 'console.log("unknown script executed")\n' > unknown-script.js
  )
}

prepare_policy_jj() {
  local root="$GUIDED_ROOT/policy-jj" repo="$GUIDED_ROOT/policy-jj/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
    mise install >/dev/null
    mise run install >/dev/null
    configure_repo "$ATLR_REPO" jj none disabled
    mkdir -p manual-policy
    printf 'jj dirty original\n' > manual-policy/dirty-delete.txt
    jj commit -m 'test: establish Jujutsu policy baseline' >/dev/null
    printf 'jj uncommitted contents\n' >> manual-policy/dirty-delete.txt
  )
}

prepare_control() {
  local root="$GUIDED_ROOT/control" repo="$GUIDED_ROOT/control/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
    mise install >/dev/null
    mise run install >/dev/null
    node ./bin/atlr.mjs init --beads >/dev/null
    cat >.atelier/validation.json <<'JSON'
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
      "command": ["node", "--no-warnings", "--experimental-strip-types", "--import", "./tests/test-environment.ts", "--test", "tests/version.test.ts"],
      "category": "focused",
      "focused": true,
      "required": true,
      "paths": ["packages/core/src/version.ts", "tests/version.test.ts"]
    }
  }
}
JSON
    jj commit -m 'test: establish Atelier guided-control baseline' >/dev/null
  )
}

write_guides() {
  mkdir -p "$GUIDED_ROOT/guides"
  cat >"$GUIDED_ROOT/guides/01-intel-jj.md" <<'GUIDE'
# Step 1 — Jujutsu footer and persistent reports

Run these commands inside Pi:

1. `/status`
2. `/workflow`
3. `/code-status`
4. `/code-index`
5. `/code-search Where is the authoritative task closure predicate implemented?`
6. `/code-symbols AtelierCore`

Expected:

- The footer heading is `jj:`, never Git `detached`.
- `intel:` becomes `ready` after indexing.
- The thinking level uses normal readable text rather than dim text.
- Every slash-command result remains in transcript scrollback after the next command.
- `/status` and `/code-status` render expandable cards with bold field/value summaries.
- `/workflow` renders a concise durable workflow card distinct from `/status`.
- Card headers use `➤` when collapsed and `▼` when expanded, with dividers between consecutive reports.
- Symbol results separate the exact `AtelierCore` definition from references.

Exit Pi with Ctrl-D.
GUIDE

  cat >"$GUIDED_ROOT/guides/02-policy-git.md" <<GUIDE
# Step 2 — Git recoverability and concrete prompts

Inside Pi, run `/status` first. The footer must use `git:` and `intel: disabled`.

## Typed tools — no approval expected

Send this model message:

> Use only typed read, write, and edit tools. Read manual-policy/clean-read.txt, create manual-policy/typed-created.txt containing "typed created", append "typed edit" to manual-policy/clean-edit.txt, do not use Bash, and stop.

## Direct user shell — no approval expected

\`!printf 'user shell create\\n' > manual-policy/user-created.txt\`

\`!rm manual-policy/clean-delete.txt\`

\`!rm manual-policy/dirty-delete.txt\`

\`!printf 'read-only output\\n'\`

The dirty tracked deletion must create a verified checkpoint automatically.

## Reject each protected or unrecoverable operation

\`!cat .env.acceptance\`

\`!rm manual-policy/untracked-delete.txt\`

\`!rm manual-policy/ignored-delete.txt\`

\`!printf 'outside\\n' > "$RUN_ROOT/outside-write-must-not-exist.txt"\`

\`!node unknown-script.js\`

Expected reasons: secret access, unrecoverable untracked/ignored deletion, outside-workspace write, and indeterminate persistent effects.

## Model Bash — no approval expected

Send:

> Use Bash to run exactly: printf 'model read-only output\\n'

Exit Pi with Ctrl-D.
GUIDE

  cat >"$GUIDED_ROOT/guides/03-policy-jj.md" <<'GUIDE'
# Step 3 — Jujutsu native recovery

Inside Pi:

1. Run `/status`; footer must use `jj:` and `intel: disabled`.
2. Run `!rm manual-policy/dirty-delete.txt`.

Expected: no approval. Atelier snapshots the Jujutsu operation and allows the recoverable deletion.

Exit Pi with Ctrl-D. The harness will restore the newest checkpoint and verify the original dirty working-copy content.
GUIDE

  cat >"$GUIDED_ROOT/guides/04-approval.md" <<'GUIDE'
# Step 4 — Plan review, rejection, and idle approval

Run:

`/plan Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to packages/core/src/version.ts and add tests/version.test.ts verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. Do not change release metadata or any other behavior.`

When the editor opens, replace the plan with one task whose execution object writes only:

- `packages/core/src/version.ts`
- `tests/version.test.ts`

and declares validation `manual-acceptance`, no dependency changes, no full suite, and one local change.

Then:

1. Run `/approve` and reject it. Verify no task starts.
2. Run `/approve` again and accept it.
3. Verify Pi remains idle and source files are unchanged.
4. Run `/status` and `/workflow`; both reports must remain in scrollback.

Exit Pi with Ctrl-D.
GUIDE

  cat >"$GUIDED_ROOT/guides/05-control.md" <<'GUIDE'
# Step 5 — Stop, pause, resume, and cancel

This continues the approved task from step 4.

1. Send: `Implement the active task using only read, edit, and write. Do not use Bash, validate, commit, or close. Stop after the two approved source changes.`
2. Start a read-only explanation turn and run `/atelier-stop` while it is working. Task and execution must remain active.
3. Run `/atelier-pause manual guided pause`.
4. Ask for a typed edit adding `// pause-probe`; it must be blocked.
5. Run `/atelier-resume`; no model turn should start automatically.
6. Run `/cancel manual guided cancellation`; execution constraints must be revoked, the Beads task must remain open, and source changes must remain.

Exit Pi with Ctrl-D.
GUIDE
}

guided_workspaces_ready() {
  local required=(
    "$GUIDED_ROOT/intel-jj/env.sh"
    "$GUIDED_ROOT/intel-jj/repo"
    "$GUIDED_ROOT/policy-git/env.sh"
    "$GUIDED_ROOT/policy-git/repo"
    "$GUIDED_ROOT/policy-jj/env.sh"
    "$GUIDED_ROOT/policy-jj/repo"
    "$GUIDED_ROOT/control/env.sh"
    "$GUIDED_ROOT/control/repo"
    "$GUIDED_ROOT/guides/01-intel-jj.md"
    "$GUIDED_ROOT/guides/02-policy-git.md"
    "$GUIDED_ROOT/guides/03-policy-jj.md"
    "$GUIDED_ROOT/guides/04-approval.md"
    "$GUIDED_ROOT/guides/05-control.md"
  )
  local path
  for path in "${required[@]}"; do
    [[ -e "$path" ]] || return 1
  done
}

prepare_manual() {
  load_run
  local automated_repo="$RUN_ROOT/repo"
  [[ -d "$automated_repo/.git" ]] || fail "automated repository is missing: $automated_repo"
  SOURCE_REPO="$(git -C "$automated_repo" remote get-url origin)"
  SOURCE_REPO="$(canonical_dir "$SOURCE_REPO")"
  log "prepare guided workspaces"
  rm -rf "$GUIDED_ROOT"
  mkdir -p "$GUIDED_ROOT" "$EVIDENCE_DIR"
  prepare_intel_jj
  prepare_policy_git
  prepare_policy_jj
  prepare_control
  write_guides
  : >"$GUIDED_ROOT/.prepared"
  : >"$RESULTS_FILE"
  pass "guided workspaces prepared under $GUIDED_ROOT"
}

banner() {
  local step="$1" title="$2" repo="$3" vcs="$4" intel="$5" guide="$6"
  clear_screen
  printf 'Atelier guided verification — step %s of 5\n\n' "$step"
  printf 'test:       %s\n' "$title"
  printf 'workspace:  %s\n' "$repo"
  printf 'VCS:        %s (intentional for this step)\n' "$vcs"
  printf 'intel:      %s\n' "$intel"
  printf 'guide:      %s\n\n' "$guide"
  printf 'Open the guide in a second terminal, or review it now with:\n  less %q\n\n' "$guide"
  read -r -p 'Press Enter to clear this screen and launch Pi... '
  clear_screen
}

record_result() {
  local step="$1" title="$2" result notes
  while true; do
    read -r -p "Result for step $step — $title [p=pass, f=fail, s=skip]: " result
    case "$result" in p|P) result=PASS; break;; f|F) result=FAIL; break;; s|S) result=SKIP; break;; esac
  done
  read -r -p 'Optional notes (one line): ' notes || true
  printf '%s\t%s\t%s\t%s\n' "$step" "$result" "$title" "${notes:-}" >>"$RESULTS_FILE"
  if [[ "$result" == FAIL && "${ATELIER_GUIDED_KEEP_GOING:-0}" != 1 ]]; then
    archive_evidence >/dev/null
    fail "manual step $step failed; evidence preserved under $RUN_ROOT"
  fi
}

collect_workspace() {
  local name="$1"
  local root="$GUIDED_ROOT/$name"
  local repo="$root/repo"
  local out="$EVIDENCE_DIR/guided-$name"
  mkdir -p "$out"
  [[ -f "$root/env.sh" ]] || return 0
  (
    source "$root/env.sh"
    cd "$repo"
    node ./bin/atlr.mjs status --json >"$out/status.json" 2>"$out/status.stderr" || true
    node ./bin/atlr.mjs state --json >"$out/state.json" 2>"$out/state.stderr" || true
    node ./bin/atlr.mjs ledger tail --limit 200 --json >"$out/ledger.json" 2>"$out/ledger.stderr" || true
    node ./bin/atlr.mjs recovery list --json >"$out/recovery.json" 2>"$out/recovery.stderr" || true
    git status --short >"$out/git-status.txt" 2>&1 || true
    git diff >"$out/git-diff.patch" 2>&1 || true
    jj status --color never >"$out/jj-status.txt" 2>&1 || true
    jj diff --color never >"$out/jj-diff.patch" 2>&1 || true
    bd list --json >"$out/beads.json" 2>"$out/beads.stderr" || true
  )
}

restore_latest_checkpoint() {
  local name="$1"
  local root="$GUIDED_ROOT/$name"
  local repo="$root/repo"
  local list="$EVIDENCE_DIR/guided-$name/recovery-before-restore.json"
  mkdir -p "$(dirname "$list")"
  (
    source "$root/env.sh"
    cd "$repo"
    node ./bin/atlr.mjs recovery list --json >"$list"
    local_id="$(node --input-type=module - "$list" <<'NODE'
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const list = Array.isArray(data) ? data : data.checkpoints ?? [];
if (list.length > 0) process.stdout.write(String(list.at(-1).id));
NODE
)"
    if [[ -n "$local_id" ]]; then
      node ./bin/atlr.mjs recovery restore "$local_id" >"$EVIDENCE_DIR/guided-$name/recovery-restore.txt"
    fi
  )
}

launch_step() {
  local step="$1" name="$2" title="$3" vcs="$4" intel="$5"
  local root="$GUIDED_ROOT/$name"
  local repo="$root/repo"
  local guide_name
  case "$step" in
    1) guide_name="intel-jj" ;;
    2) guide_name="policy-git" ;;
    3) guide_name="policy-jj" ;;
    4) guide_name="approval" ;;
    5) guide_name="control" ;;
    *) fail "unknown guided step: $step" ;;
  esac
  local guide="$GUIDED_ROOT/guides/0${step}-${guide_name}.md"
  [[ -d "$repo" ]] || fail "guided workspace is missing: $repo"
  banner "$step" "$title" "$repo" "$vcs" "$intel" "$guide"
  TUI_TERMINAL_DIRTY=1
  set +e
  (
    source "$root/env.sh"
    cd "$repo"
    mise run launch
  )
  local rc=$?
  set -e
  restore_terminal
  clear_screen
  printf 'Pi exited with status %s. Collecting authoritative evidence...\n' "$rc"
  collect_workspace "$name"
  if [[ "$step" == 2 || "$step" == 3 ]]; then
    restore_latest_checkpoint "$name" || true
    collect_workspace "$name"
  fi
  record_result "$step" "$title"
}

run_guided() {
  load_run
  local start="${1:-1}"
  if ! guided_workspaces_ready; then
    if [[ -s "$RESULTS_FILE" ]]; then
      fail "guided workspaces are incomplete after results were recorded; run '$PROGRAM prepare' to reset them explicitly"
    fi
    log "guided workspaces are missing or incomplete; preparing them now"
    prepare_manual
  fi
  (( start <= 1 )) && launch_step 1 intel-jj 'Jujutsu footer and persistent Markdown reports' jj ready
  (( start <= 2 )) && launch_step 2 policy-git 'Git recoverability and consequence-based prompts' git disabled
  (( start <= 3 )) && launch_step 3 policy-jj 'Jujutsu native checkpoint and restoration' jj disabled
  (( start <= 4 )) && launch_step 4 control 'Plan review, rejection, and idle approval' jj disabled
  (( start <= 5 )) && launch_step 5 control 'Stop, pause, resume, and cancellation' jj disabled
  archive_evidence >/dev/null
  clear_screen
  pass "guided verification complete"
  printf 'Results:  %s\n' "$RESULTS_FILE"
  printf 'Evidence: %s\n' "$RUN_ROOT/atelier-guided-verification-evidence.tar.xz"
}

archive_evidence() {
  load_run
  local output="$RUN_ROOT/atelier-guided-verification-evidence.tar.xz"
  tar -C "$RUN_ROOT" -cJf "$output" evidence guided env.sh 2>/dev/null || tar -C "$RUN_ROOT" -cJf "$output" evidence guided
  printf '%s\n' "$output"
}

show_status() {
  load_run
  printf 'run:      %s\n' "$RUN_ROOT"
  printf 'guided:   %s\n' "$GUIDED_ROOT"
  printf 'results:  %s\n' "$RESULTS_FILE"
  [[ -s "$RESULTS_FILE" ]] && { printf '\n'; column -t -s $'\t' "$RESULTS_FILE" 2>/dev/null || cat "$RESULTS_FILE"; }
  for name in intel-jj policy-git policy-jj control; do
    [[ -d "$GUIDED_ROOT/$name/repo" ]] && printf '%-12s %s\n' "$name" "$GUIDED_ROOT/$name/repo"
  done
}

run_automated() {
  local source="${1:-$PWD}"
  source="$(canonical_dir "$source")"
  require_command mise
  if [[ "${ATELIER_GUIDED_SKIP_CHECK:-0}" != 1 ]]; then
    log "deterministic source gate"
    (cd "$source" && mise run check)
  else
    printf 'WARNING: skipping deterministic source gate because ATELIER_GUIDED_SKIP_CHECK=1\n'
  fi
  log "automated live acceptance"
  "$source/scripts/live-acceptance.sh" all "$source"
  load_run
  prepare_manual
}

main() {
  case "${1:-}" in
    all) shift; run_automated "${1:-$PWD}"; run_guided 1 ;;
    automated) shift; run_automated "${1:-$PWD}" ;;
    prepare) prepare_manual ;;
    guided) shift; run_guided "${1:-1}" ;;
    status) show_status ;;
    archive) archive_evidence ;;
    -h|--help|help|'') usage ;;
    *) usage >&2; fail "unknown command: ${1:-}" ;;
  esac
}

main "$@"
