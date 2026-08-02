#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

PROGRAM="$(basename "$0")"
HARNESS_VERSION="41.1"
EXPECTED_ATELIER_VERSION="${ATELIER_GUIDED_EXPECTED_VERSION:-0.14.0-alpha.41}"
MANUAL_PARENT="${ATELIER_MANUAL_PARENT:-$HOME/workspace/scratch}"
RUN_PREFIX="atelier-manual-"
POINTER_FILE="${ATELIER_ACCEPTANCE_POINTER:-$HOME/.atelier-manual-current}"
SOURCE_REPO=""
RUN_ROOT=""
GUIDED_ROOT=""
EVIDENCE_DIR=""
RESULTS_FILE=""
TUI_TERMINAL_DIRTY=0
LIVE_TOOLCHAIN_SOURCE=""
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"

log() { printf '\n==> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage:
  $PROGRAM fresh [SOURCE_REPO]
  $PROGRAM purge
  $PROGRAM all [SOURCE_REPO]
  $PROGRAM automated [SOURCE_REPO]
  $PROGRAM prepare
  $PROGRAM guided [STEP]
  $PROGRAM retry STEP
  $PROGRAM status
  $PROGRAM archive

Recommended clean start:
  $PROGRAM fresh ~/workspace/personal/atelier

Typical continuation after live acceptance:
  $PROGRAM guided

Commands:
  fresh      Verify SOURCE_REPO, remove all old Atelier manual-test runs under
             ATELIER_MANUAL_PARENT, then run automated and guided verification.
  purge      Remove old Atelier manual-test runs and the current pointer only.
  all        Run deterministic and automated gates, prepare guided workspaces,
             then walk through every manual TUI step.
  automated  Run deterministic and automated gates, then prepare manual workspaces.
  prepare    Recreate only the disposable guided workspaces for the current run.
  guided     Walk through manual steps 1-5; optionally start at STEP.
  retry      Recreate and rerun exactly one failed disposable step.
             Step 5 depends on step 4 and must be retried with: retry 4
  status     Show current run, workspaces, and recorded manual outcomes.
  archive    Rebuild the combined evidence archive.

Environment:
  ATELIER_GUIDED_SKIP_CHECK=1  Skip mise run check when it already passed.
  ATELIER_GUIDED_KEEP_GOING=1  Preserve evidence and continue after a recorded FAIL.
  ATELIER_GUIDED_PURGE_CONFIRM=1
                                  Skip the PURGE confirmation for fresh/purge.
  ATELIER_MANUAL_PARENT           Manual-test parent (default: ~/workspace/scratch).
  ATELIER_GUIDED_EXPECTED_VERSION Expected Atelier version (default: 0.14.0-alpha.41).
USAGE
}

canonical_dir() { (cd "$1" && pwd -P); }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"; }
is_test_mode() { [[ "${ATELIER_GUIDED_TEST_MODE:-0}" == 1 ]]; }

toolchain_source_for_command() {
  local command="${1:-}"
  local source root repo

  case "$command" in
    fresh|all|automated)
      source="${2:-$PWD}"
      [[ -d "$source" ]] || return 1
      canonical_dir "$source"
      ;;
    prepare|guided|retry|status|archive)
      [[ -f "$POINTER_FILE" ]] || return 1
      root="$(<"$POINTER_FILE")"
      repo="$root/repo"
      [[ -f "$repo/mise.toml" ]] || return 1
      canonical_dir "$repo"
      ;;
    *)
      return 1
      ;;
  esac
}

activate_mise_environment() {
  is_test_mode && return 0
  [[ "${ATELIER_GUIDED_MISE_ACTIVE:-0}" == 1 ]] && return 0

  local source
  source="$(toolchain_source_for_command "$@" 2>/dev/null || true)"
  [[ -n "$source" ]] || return 0

  require_command mise
  log "activate the Atelier toolchain through mise"
  (cd "$source" && mise install)

  # `mise install` installs configured tools but does not mutate the PATH of the
  # already-running shell. Re-exec the complete standalone harness through
  # `mise exec` so Jujutsu, codesearch, Node, and the remaining project tools
  # stay available after the harness changes into disposable cloned workspaces.
  cd "$source"
  exec env ATELIER_GUIDED_MISE_ACTIVE=1 \
    mise exec -- bash "$SCRIPT_PATH" "$@"
}

ensure_live_toolchain() {
  local source="$1"
  [[ "$LIVE_TOOLCHAIN_SOURCE" == "$source" ]] && return 0
  is_test_mode && { LIVE_TOOLCHAIN_SOURCE="$source"; return 0; }

  log "verify live-acceptance toolchain"
  # The standalone harness can be launched from ~/Downloads, where the source
  # repository's mise-managed tools are not necessarily present in the caller's
  # PATH. Install the pinned tools, then probe the complete live toolchain inside
  # a mise exec environment before deleting any previous acceptance evidence.
  (cd "$source" && mise install)

  local missing=()
  local tool
  for tool in git node mise jj bd codesearch pi python3; do
    if ! (
      cd "$source"
      mise exec -- sh -c 'command -v "$1" >/dev/null 2>&1' sh "$tool"
    ); then
      missing+=("$tool")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf 'The live-acceptance environment is missing required commands:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    printf 'Atelier tools declared in mise.toml are resolved through `mise exec`; Pi and Beads must also be installed and visible to that environment.\n' >&2
    fail "live-acceptance toolchain preflight failed before purge"
  fi

  LIVE_TOOLCHAIN_SOURCE="$source"
  pass "live-acceptance toolchain is available through mise exec"
}

manual_parent_dir() {
  mkdir -p "$MANUAL_PARENT"
  canonical_dir "$MANUAL_PARENT"
}

managed_run_path() {
  local candidate="$1"
  local parent canonical
  [[ -d "$candidate" ]] || return 1
  parent="$(manual_parent_dir)"
  canonical="$(canonical_dir "$candidate")"
  [[ "$(dirname "$canonical")" == "$parent" && "$(basename "$canonical")" == "$RUN_PREFIX"* ]]
}

verify_source_release() {
  local source="$1"
  is_test_mode && return 0
  [[ -f "$source/package.json" ]] || fail "not an Atelier checkout: $source"
  [[ -d "$source/.git" ]] || fail "Atelier source is not a Git checkout: $source"

  local version tag
  version="$(node -p "require('$source/package.json').version")"
  [[ "$version" == "$EXPECTED_ATELIER_VERSION" ]] \
    || fail "expected Atelier $EXPECTED_ATELIER_VERSION, found $version in $source"

  tag="$(git -C "$source" describe --tags --exact-match 2>/dev/null || true)"
  [[ "$tag" == "v$EXPECTED_ATELIER_VERSION" ]] \
    || fail "source HEAD is not tagged v$EXPECTED_ATELIER_VERSION (found: ${tag:-none})"

  local dirty
  dirty="$(git -C "$source" status --short)"
  [[ -z "$dirty" ]] || {
    printf '%s\n' "$dirty" >&2
    fail "source checkout is dirty: $source"
  }
}

purge_old_runs() {
  local parent
  parent="$(manual_parent_dir)"
  [[ "$parent" != "/" && "$parent" != "$HOME" ]] \
    || fail "refusing to purge unsafe manual-test parent: $parent"

  local runs=()
  local path
  while IFS= read -r -d '' path; do
    runs+=("$path")
  done < <(find "$parent" -mindepth 1 -maxdepth 1 -type d -name "${RUN_PREFIX}*" -print0)

  printf 'Manual-test parent: %s\n' "$parent"
  if [[ "${#runs[@]}" -eq 0 ]]; then
    printf 'No old Atelier manual-test runs were found.\n'
  else
    printf 'The following disposable test runs will be removed:\n'
    printf '  %s\n' "${runs[@]}"
    if [[ "${ATELIER_GUIDED_PURGE_CONFIRM:-0}" != 1 ]]; then
      local confirmation
      read -r -p 'Type PURGE to remove these test runs: ' confirmation
      [[ "$confirmation" == PURGE ]] || fail "purge cancelled"
    fi
    for path in "${runs[@]}"; do
      managed_run_path "$path" || fail "refusing to remove unmanaged path: $path"
      rm -rf -- "$path"
    done
  fi

  rm -f -- "$POINTER_FILE"
  pass "old Atelier manual-test runs and pointer were removed"
}

write_workspace_metadata() {
  local name="$1" root="$2" repo="$3"
  if is_test_mode; then
    cat >"$root/workspace-version.txt" <<META
Harness: $HARNESS_VERSION
Expected Atelier: $EXPECTED_ATELIER_VERSION
Workspace: $name
Repository: $repo
Package version: $EXPECTED_ATELIER_VERSION
Source commit: test
Source tag: v$EXPECTED_ATELIER_VERSION
Prepared at: test
META
    return 0
  fi
  local source_commit source_tag package_version
  source_commit="$(git -C "$repo" rev-parse refs/remotes/origin/main 2>/dev/null || git -C "$repo" rev-parse HEAD)"
  source_tag="$(git -C "$repo" describe --tags --exact-match "$source_commit" 2>/dev/null || true)"
  package_version="$(node -p "require('$repo/package.json').version")"
  cat >"$root/workspace-version.txt" <<META
Harness: $HARNESS_VERSION
Expected Atelier: $EXPECTED_ATELIER_VERSION
Workspace: $name
Repository: $repo
Package version: $package_version
Source commit: $source_commit
Source tag: ${source_tag:-none}
Prepared at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
META
  [[ "$package_version" == "$EXPECTED_ATELIER_VERSION" ]] \
    || fail "$name workspace contains Atelier $package_version, expected $EXPECTED_ATELIER_VERSION"
  [[ "$source_tag" == "v$EXPECTED_ATELIER_VERSION" ]] \
    || fail "$name workspace source commit is not tagged v$EXPECTED_ATELIER_VERSION"
}

json_assert() {
  local file="$1" body="$2"
  node --input-type=module - "$file" "$body" <<'NODE'
import { readFileSync } from "node:fs";
const [file, body] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
Function("data", "assert", body)(data, assert);
NODE
}

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
    mise install >/dev/null
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
    mise run install >/dev/null
  )
  write_workspace_metadata intel-jj "$root" "$repo"
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
    cat > unknown-script.js <<'JS'
import { writeFileSync } from "node:fs";
writeFileSync("manual-policy/unknown-script-ran.txt", "executed\n", "utf8");
JS
  )
  write_workspace_metadata policy-git "$root" "$repo"
}

prepare_policy_jj() {
  local root="$GUIDED_ROOT/policy-jj" repo="$GUIDED_ROOT/policy-jj/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    mise install >/dev/null
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
    mise run install >/dev/null
    configure_repo "$ATLR_REPO" jj none disabled
    mkdir -p manual-policy
    printf 'jj dirty original\n' > manual-policy/dirty-delete.txt
    jj commit -m 'test: establish Jujutsu policy baseline' >/dev/null
    printf 'jj uncommitted contents\n' >> manual-policy/dirty-delete.txt
  )
  write_workspace_metadata policy-jj "$root" "$repo"
}

prepare_control() {
  local root="$GUIDED_ROOT/control" repo="$GUIDED_ROOT/control/repo"
  rm -rf "$root"; mkdir -p "$root"
  git clone --no-hardlinks "$SOURCE_REPO" "$repo" >/dev/null
  write_env "$root" "$repo"
  (
    source "$root/env.sh"
    cd "$ATLR_REPO"
    mise install >/dev/null
    jj git init --colocate >/dev/null
    chmod 700 .beads 2>/dev/null || true
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
  write_workspace_metadata control "$root" "$repo"
}

write_guides() {
  mkdir -p "$GUIDED_ROOT/guides"
  cat >"$GUIDED_ROOT/guides/01-intel-jj.md" <<'GUIDE'
# Step 1 — Jujutsu footer and persistent reports

Run these checks inside Pi:

1. Note the current thinking level in the Atelier footer. Use Pi's thinking-level shortcut to select a different level. The footer must change immediately without running an Atelier command.
2. `/performance clear`
3. `/status`
4. `/status` again without changing any files.
5. `/workflow`
6. `/performance`
7. `/code-status`
8. `/code-index`
9. `/code-search Where is the authoritative task closure predicate implemented?`
10. `/code-symbols AtelierCore`
11. `/atelier-open apps/pi-extension/src/command-reports.ts:63`

Expected:

- The footer heading is `jj:`, never Git `detached`.
- The footer's model and thinking-level values update immediately when Pi changes them.
- `intel:` becomes `ready` after indexing.
- The thinking level uses normal readable text rather than dim text.
- Every slash-command result remains in transcript scrollback after the next command.
- `/status` and `/workflow` show an Atelier working phase immediately instead of leaving the UI apparently frozen.
- The second `/status` reuses the recent repository observation when nothing changed.
- `/status` and `/code-status` render expandable cards with bold field/value summaries.
- Default `/workflow` renders a concise ledger/status-only card distinct from `/status`; it does not start semantic retrieval.
- `/performance` contains `/status/total`, repository observation, subprocess, hashing, cache, and SQLite summaries.
- Card headers use `➤` when collapsed and `▼` when expanded, with dividers between consecutive reports.
- Symbol results separate the exact `AtelierCore` definition from references.
- `/atelier-open` suspends Pi, opens the configured editor at line 63, and returns to the same usable Pi session after the editor exits.

Exit Pi with Ctrl-D.
GUIDE

  {
    cat <<'GUIDE'
# Step 2 — Git recoverability and concrete prompts

Inside Pi, run `/status` first. The footer must use `git:` and `intel: disabled`.

## Typed tools in investigate mode

Send this model message:

> Use only typed read, write, and edit tools. Read manual-policy/clean-read.txt, create manual-policy/typed-created.txt containing "typed created", append "typed edit" to manual-policy/clean-edit.txt, do not use Bash, and stop.

Expected:

- The read succeeds.
- The typed create and edit are blocked because investigate mode is read-only.
- `manual-policy/typed-created.txt` is not created.
- `manual-policy/clean-edit.txt` remains unchanged.

## Direct user shell — automatically allowed by recoverability policy

`!printf 'user shell create\n' > manual-policy/user-created.txt`

`!rm manual-policy/clean-delete.txt`

`!rm manual-policy/dirty-delete.txt`

`!rm manual-policy/untracked-delete.txt`

`!rm manual-policy/ignored-delete.txt`

`!printf 'read-only output\n'`

Expected:

- None of these commands prompts for approval.
- The output renders in Pi and Pi remains usable.
- The clean tracked deletion is recoverable directly from Git.
- The dirty tracked, untracked, and ignored deletions each create a verified checkpoint before execution.
- After Pi exits, the harness restores and verifies all three checkpointed paths and prints their IDs and restored paths.

## Explicit prompts — reject each operation

`!cat .env.acceptance`
GUIDE
    printf '\n`!printf '\''outside\\n'\'' > "%s/outside-write-must-not-exist.txt"`\n\n' "$RUN_ROOT"
    cat <<'GUIDE'
`!node unknown-script.js`

When each approval prompt appears, choose **No**. Atelier must show repository/effect-analysis feedback before the dialog rather than remaining blank for several seconds.

Expected reasons: secret access, outside-workspace write, and indeterminate persistent effects.
After each rejection, Pi must clearly indicate that Atelier denied the command and that it was not executed. A normal-looking successful shell row is a UX failure even when the ledger correctly records denial.

The harness independently verifies that:

- the outside-workspace marker does not exist;
- `manual-policy/unknown-script-ran.txt` does not exist;
- the ledger contains three separate `workspace_policy.approval_denied` events with the expected reasons;
- no prompted operation received `workspace_policy.approval_granted`.

## Model Bash — no approval expected

Send:

> Use Bash to run exactly: printf 'model read-only output\n'

Exit Pi with Ctrl-D. The harness will verify command execution, denial events, exact checkpoint path coverage, and restoration before asking for the result.
GUIDE
  } >"$GUIDED_ROOT/guides/02-policy-git.md"

  cat >"$GUIDED_ROOT/guides/03-policy-jj.md" <<'GUIDE'
# Step 3 — Jujutsu native recovery

Inside Pi:

1. Run `/status`; footer must use `jj:` and `intel: disabled`.
2. Run `!rm manual-policy/dirty-delete.txt`.

Expected: no approval. Atelier snapshots the Jujutsu operation and allows the recoverable deletion.

Exit Pi with Ctrl-D. The harness will print the checkpoint ID, restore it, and verify the original dirty working-copy content.
GUIDE

  cat >"$GUIDED_ROOT/guides/04-approval.md" <<'GUIDE'
# Step 4 — Plan review, rejection, and idle approval

Run:

`/plan Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to packages/core/src/version.ts and add tests/version.test.ts verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. Do not change release metadata or any other behavior.`

When the editor opens, **do not replace or repair the generated plan**. Inspect the task exactly as generated.

It must contain this execution object:

`<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["packages/core/src/version.ts","tests/version.test.ts"],"allowDependencyChanges":false,"validations":["manual-acceptance"],"allowFullSuite":false,"allowLocalChange":true}} -->`

Also verify that the human-readable `### Validation` and `### Completion criteria` sections name `manual-acceptance`, not an invented validation such as `typecheck`.

The exact reviewed write paths are:

- `packages/core/src/version.ts`
- `tests/version.test.ts`

If any field or validation name is wrong, leave the plan unchanged, exit Pi, and record this step as **FAIL**. Manually correcting generated metadata would hide the planner defect this step is intended to test.

If the plan is correct, save it unchanged and close the editor.

Then:

1. Run `/approve` and reject it. Atelier must show preparation feedback promptly. Verify no task starts.
2. Run `/approve` again and accept it. Revalidation, reconciliation, convergence, and activation phases must remain visible while they run.
3. Verify Pi remains idle and source files are unchanged.
4. Run `/status`, `/workflow`, and `/performance`; all reports must remain in scrollback and the performance report must include approval/repository timing rather than an unexplained silent gap.

Exit Pi with Ctrl-D.
GUIDE

  cat >"$GUIDED_ROOT/guides/05-control.md" <<'GUIDE'
# Step 5 — Stop, pause, resume, and cancel

This continues the approved task from step 4.

1. Send: `Implement the active task using only read, edit, and write. Do not use Bash, validate, commit, or close. Stop after the two approved source changes.`
2. Start a read-only explanation turn and run `/atelier-stop` while it is working. Task and execution must remain active.
3. Run `/atelier-pause manual guided pause`.
4. Send this exact model message:

   > Using only the typed edit tool, add the exact line `// pause-probe` to packages/core/src/version.ts. Do not use Bash or any other tool.

   Expected: Atelier blocks the edit because execution is paused, and `packages/core/src/version.ts` does not contain `// pause-probe`.
5. Run `/atelier-resume`; no model turn should start automatically.
6. Run `/cancel manual guided cancellation`; execution constraints must be revoked, the Beads task must remain open, and source changes must remain.

Exit Pi with Ctrl-D.
GUIDE
}

guided_workspaces_ready() {
  local required=(
    "$GUIDED_ROOT/intel-jj/env.sh"
    "$GUIDED_ROOT/intel-jj/workspace-version.txt"
    "$GUIDED_ROOT/intel-jj/repo"
    "$GUIDED_ROOT/policy-git/env.sh"
    "$GUIDED_ROOT/policy-git/workspace-version.txt"
    "$GUIDED_ROOT/policy-git/repo"
    "$GUIDED_ROOT/policy-jj/env.sh"
    "$GUIDED_ROOT/policy-jj/workspace-version.txt"
    "$GUIDED_ROOT/policy-jj/repo"
    "$GUIDED_ROOT/control/env.sh"
    "$GUIDED_ROOT/control/workspace-version.txt"
    "$GUIDED_ROOT/control/repo"
    "$GUIDED_ROOT/.prepared"
  )
  local path
  for path in "${required[@]}"; do
    if is_test_mode && [[ "$path" == */workspace-version.txt ]]; then
      continue
    fi
    [[ -e "$path" ]] || return 1
  done
}

prepare_manual() {
  load_run
  local automated_repo="$RUN_ROOT/repo"
  [[ -d "$automated_repo/.git" ]] || fail "automated repository is missing: $automated_repo"
  SOURCE_REPO="$(git -C "$automated_repo" remote get-url origin)"
  SOURCE_REPO="$(canonical_dir "$SOURCE_REPO")"
  verify_source_release "$SOURCE_REPO"
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
  printf 'Pi session: fresh (--no-session)\n'
  printf 'guide:      %s\n\n' "$guide"
  printf 'Open the guide in a second terminal, or review it now with:\n  less %q\n\n' "$guide"
  read -r -p 'Press Enter to clear this screen and launch Pi... '
  clear_screen
}

write_result_row() {
  local step="$1" result="$2" title="$3" notes="${4:-}"
  notes="${notes//$'\t'/ }"
  notes="${notes//$'\r'/ }"
  notes="${notes//$'\n'/ }"
  remove_recorded_steps "$step"
  printf '%s\t%s\t%s\t%s\n' "$step" "$result" "$title" "$notes" >>"$RESULTS_FILE"
  local sorted="$RESULTS_FILE.sorted"
  LC_ALL=C sort -t $'\t' -k1,1n -s "$RESULTS_FILE" >"$sorted"
  mv "$sorted" "$RESULTS_FILE"
}

record_result() {
  local step="$1" title="$2" result notes
  while true; do
    read -r -p "Result for step $step — $title [p=pass, f=fail, s=skip]: " result
    case "$result" in p|P) result=PASS; break;; f|F) result=FAIL; break;; s|S) result=SKIP; break;; esac
  done
  read -r -p 'Optional notes (one line): ' notes || true
  write_result_row "$step" "$result" "$title" "${notes:-}"
  if [[ "$result" == FAIL && "${ATELIER_GUIDED_KEEP_GOING:-0}" != 1 ]]; then
    archive_evidence >/dev/null
    fail "manual step $step failed; evidence preserved under $RUN_ROOT"
  fi
}

record_automatic_failure() {
  local step="$1" title="$2" reason="$3" notes
  printf 'AUTOMATIC FAIL: %s\n' "$reason" >&2
  read -r -p 'Optional notes (one line): ' notes || true
  write_result_row "$step" FAIL "$title" "${notes:-$reason}"
  archive_evidence >/dev/null
  if [[ "${ATELIER_GUIDED_KEEP_GOING:-0}" != 1 ]]; then
    fail "manual step $step failed objective verification; evidence preserved under $RUN_ROOT"
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
    cp "$root/workspace-version.txt" "$out/workspace-version.txt" 2>/dev/null || true
    node ./bin/atlr.mjs --version >"$out/atlr-version.txt" 2>"$out/atlr-version.stderr" || true
    git rev-parse HEAD >"$out/git-head.txt" 2>&1 || true
    git describe --tags --exact-match >"$out/git-tag.txt" 2>&1 || true
    node ./bin/atlr.mjs status --json >"$out/status.json" 2>"$out/status.stderr" || true
    node ./bin/atlr.mjs state --json >"$out/state.json" 2>"$out/state.stderr" || true
    node ./bin/atlr.mjs plan parse --json >"$out/plan.json" 2>"$out/plan.stderr" || true
    node ./bin/atlr.mjs changed --json >"$out/changed.json" 2>"$out/changed.stderr" || true
    node ./bin/atlr.mjs ledger tail --limit 400 --json >"$out/ledger.json" 2>"$out/ledger.stderr" || true
    node ./bin/atlr.mjs recovery list --json >"$out/recovery.json" 2>"$out/recovery.stderr" || true
    git status --short >"$out/git-status.txt" 2>&1 || true
    git diff >"$out/git-diff.patch" 2>&1 || true
    jj status --color never >"$out/jj-status.txt" 2>&1 || true
    jj diff --color never >"$out/jj-diff.patch" 2>&1 || true
    bd list --json >"$out/beads.json" 2>"$out/beads.stderr" || true
  )
}

verify_workspace_release() {
  local name="$1"
  is_test_mode && return 0
  local root="$GUIDED_ROOT/$name"
  local repo="$root/repo"
  [[ -f "$root/workspace-version.txt" ]] || fail "missing workspace version record: $root/workspace-version.txt"
  local version
  version="$(node -p "require('$repo/package.json').version")"
  [[ "$version" == "$EXPECTED_ATELIER_VERSION" ]] \
    || fail "$name workspace contains Atelier $version, expected $EXPECTED_ATELIER_VERSION"
  grep -Fq "Source tag: v$EXPECTED_ATELIER_VERSION" "$root/workspace-version.txt" \
    || fail "$name workspace was not prepared from v$EXPECTED_ATELIER_VERSION"
}

verify_policy_git_before_restore() {
  local root="$GUIDED_ROOT/policy-git"
  local repo="$root/repo"
  local out="$EVIDENCE_DIR/guided-policy-git"
  local outside="$RUN_ROOT/outside-write-must-not-exist.txt"

  [[ "$(cat "$repo/manual-policy/user-created.txt")" == 'user shell create' ]] \
    || fail "direct user-shell create did not complete"
  [[ ! -e "$repo/manual-policy/clean-delete.txt" ]] \
    || fail "clean tracked deletion did not execute"
  [[ ! -e "$repo/manual-policy/dirty-delete.txt" ]] \
    || fail "dirty tracked deletion did not execute before checkpoint restoration"
  [[ ! -e "$repo/manual-policy/untracked-delete.txt" ]] \
    || fail "untracked deletion did not execute before checkpoint restoration"
  [[ ! -e "$repo/manual-policy/ignored-delete.txt" ]] \
    || fail "ignored deletion did not execute before checkpoint restoration"
  [[ ! -e "$repo/manual-policy/typed-created.txt" ]] \
    || fail "investigate-mode typed create unexpectedly succeeded"
  [[ "$(cat "$repo/manual-policy/clean-edit.txt")" == 'clean edit' ]] \
    || fail "investigate-mode typed edit unexpectedly changed clean-edit.txt"
  [[ ! -e "$outside" ]] || fail "rejected outside-workspace write executed: $outside"
  [[ ! -e "$repo/manual-policy/unknown-script-ran.txt" ]] \
    || fail "rejected unknown script executed"

  node --input-type=module - "$out/ledger.json" "$out/recovery.json" "$repo" "$outside" <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [ledgerFile, recoveryFile, repo, outside] = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
const recoveryRaw = JSON.parse(readFileSync(recoveryFile, "utf8"));
const recovery = Array.isArray(recoveryRaw) ? recoveryRaw : recoveryRaw.checkpoints ?? [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const expectedCheckpointPaths = [
  "manual-policy/dirty-delete.txt",
  "manual-policy/untracked-delete.txt",
  "manual-policy/ignored-delete.txt",
].map((path) => resolve(repo, path));
const created = ledger.filter((event) => event.kind === "recovery.checkpoint_created");
const createdPaths = created.flatMap((event) => event.payload?.paths ?? []).map((value) => resolve(value));
const recoveryPaths = recovery.flatMap((checkpoint) => checkpoint.paths ?? []).map((value) => resolve(value));
for (const path of expectedCheckpointPaths) {
  assert(createdPaths.filter((candidate) => candidate === path).length === 1,
    `expected exactly one recovery.checkpoint_created event for ${path}; got ${createdPaths.join(", ")}`);
  assert(recoveryPaths.filter((candidate) => candidate === path).length === 1,
    `expected exactly one live checkpoint for ${path}; got ${recoveryPaths.join(", ")}`);
}
assert(createdPaths.length === expectedCheckpointPaths.length,
  `unexpected checkpoint path set: ${createdPaths.join(", ")}`);

const denied = ledger.filter((event) => event.kind === "workspace_policy.approval_denied");
const deniedEffects = denied.flatMap((event) => event.payload?.decision?.effects ?? []);
assert(deniedEffects.some((effect) => resolve(effect.resolvedPath ?? effect.path) === resolve(repo, ".env.acceptance") && effect.state === "potential_secret"),
  "missing secret-path approval denial");
assert(deniedEffects.some((effect) => resolve(effect.resolvedPath ?? effect.path) === resolve(outside) && effect.state === "outside_workspace"),
  "missing outside-workspace approval denial");
assert(deniedEffects.some((effect) => effect.kind === "execute" && String(effect.description ?? "").includes("unknown-script.js")),
  "missing unknown-script execution denial");
const granted = ledger.filter((event) => event.kind === "workspace_policy.approval_granted");
assert(granted.length === 0, `prompted operations unexpectedly received approval: ${granted.length}`);
NODE
  pass "Step 2 objective evidence passed before checkpoint restoration"
}

verify_policy_git_after_restore() {
  local repo="$GUIDED_ROOT/policy-git/repo"
  local out="$EVIDENCE_DIR/guided-policy-git"
  [[ "$(cat "$repo/manual-policy/dirty-delete.txt")" == $'dirty original\ndirty uncommitted' ]] \
    || fail "dirty tracked checkpoint did not restore exact contents"
  [[ "$(cat "$repo/manual-policy/untracked-delete.txt")" == 'untracked contents' ]] \
    || fail "untracked checkpoint did not restore exact contents"
  [[ "$(cat "$repo/manual-policy/ignored-delete.txt")" == 'ignored contents' ]] \
    || fail "ignored checkpoint did not restore exact contents"
  node --input-type=module - "$out/ledger.json" "$repo" <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [ledgerFile, repo] = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
const expected = [
  "manual-policy/dirty-delete.txt",
  "manual-policy/untracked-delete.txt",
  "manual-policy/ignored-delete.txt",
].map((path) => resolve(repo, path));
const restored = ledger.filter((event) => event.kind === "recovery.checkpoint_restored")
  .flatMap((event) => event.payload?.paths ?? []).map((value) => resolve(value));
for (const path of expected) {
  if (!restored.includes(path)) throw new Error(`missing recovery.checkpoint_restored for ${path}`);
}
NODE
  pass "Step 2 restored every required Git checkpoint with exact contents"
}

verify_policy_jj_before_restore() {
  local repo="$GUIDED_ROOT/policy-jj/repo"
  local out="$EVIDENCE_DIR/guided-policy-jj"
  [[ ! -e "$repo/manual-policy/dirty-delete.txt" ]] \
    || fail "Jujutsu dirty deletion did not execute before restoration"
  node --input-type=module - "$out/recovery.json" "$repo" <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [file, repo] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, "utf8"));
const checkpoints = Array.isArray(raw) ? raw : raw.checkpoints ?? [];
const expected = resolve(repo, "manual-policy/dirty-delete.txt");
const matches = checkpoints.filter((checkpoint) =>
  checkpoint.repositoryState?.provider === "jj" && (checkpoint.paths ?? []).map((value) => resolve(value)).includes(expected));
if (matches.length !== 1) throw new Error(`expected one Jujutsu checkpoint for ${expected}; got ${matches.length}`);
NODE
  pass "Step 3 created the expected Jujutsu checkpoint"
}

verify_policy_jj_after_restore() {
  local repo="$GUIDED_ROOT/policy-jj/repo"
  [[ "$(cat "$repo/manual-policy/dirty-delete.txt")" == $'jj dirty original\njj uncommitted contents' ]] \
    || fail "Jujutsu checkpoint did not restore exact dirty working-copy contents"
  pass "Step 3 restored the exact Jujutsu working-copy contents"
}

verify_control_approval() {
  local repo="$GUIDED_ROOT/control/repo"
  local out="$EVIDENCE_DIR/guided-control"
  [[ ! -e "$repo/tests/version.test.ts" ]] \
    || fail "Step 4 mutated tests/version.test.ts before implementation"
  ! grep -q 'ATELIER_PRODUCT_NAME' "$repo/packages/core/src/version.ts" \
    || fail "Step 4 mutated version.ts before implementation"

  node --input-type=module - "$out/status.json" "$out/plan.json" "$out/beads.json" "$out/ledger.json" <<'NODE'
import { readFileSync } from "node:fs";
const [statusFile, planFile, beadsFile, ledgerFile] = process.argv.slice(2);
const status = JSON.parse(readFileSync(statusFile, "utf8"));
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const beadsRaw = JSON.parse(readFileSync(beadsFile, "utf8"));
const beads = Array.isArray(beadsRaw) ? beadsRaw : Array.isArray(beadsRaw.data) ? beadsRaw.data : beadsRaw.tasks ?? [];
const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(status.workflow?.mode === "act", `expected act mode, got ${status.workflow?.mode}`);
assert(typeof status.task?.current === "string" && status.task.current !== "none", "approved task is not active");
assert(status.execution?.grant !== "none", "approved execution grant is missing");
assert(status.execution?.constraints === 1, `expected one task constraint, got ${status.execution?.constraints}`);
assert(plan.tasks?.length === 1, `expected one plan task, got ${plan.tasks?.length}`);
const task = plan.tasks[0];
const execution = task.execution;
assert(task.id === "ATLR-001", `unexpected task id: ${task.id}`);
assert(JSON.stringify(execution.writePaths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]),
  `unexpected write paths: ${JSON.stringify(execution.writePaths)}`);
assert(JSON.stringify(execution.validations) === JSON.stringify(["manual-acceptance"]),
  `unexpected validations: ${JSON.stringify(execution.validations)}`);
assert(execution.allowDependencyChanges === false, "dependency changes were allowed");
assert(execution.allowFullSuite === false, "full suite was allowed");
assert(execution.allowLocalChange === true, "local change was not allowed");
assert(beads.length === 1, `expected one Beads task, got ${beads.length}`);
const kinds = new Set(ledger.map((event) => event.kind));
for (const kind of ["execution.rejected", "execution.approval_accepted", "plan.approved", "plan.reconciled", "execution.started"]) {
  assert(kinds.has(kind), `missing ledger event ${kind}`);
}
NODE
  pass "Step 4 generated the exact plan, rejected without activation, then approved one idle task"
}

verify_control_cancellation() {
  local repo="$GUIDED_ROOT/control/repo"
  local out="$EVIDENCE_DIR/guided-control"
  grep -q 'export const ATELIER_PRODUCT_NAME = "Atelier"' "$repo/packages/core/src/version.ts" \
    || fail "Step 5 implementation did not add ATELIER_PRODUCT_NAME"
  [[ -f "$repo/tests/version.test.ts" ]] || fail "Step 5 implementation did not create tests/version.test.ts"
  ! grep -q '// pause-probe' "$repo/packages/core/src/version.ts" \
    || fail "paused typed edit was not blocked"

  node --input-type=module - "$out/status.json" "$out/changed.json" "$out/beads.json" "$out/ledger.json" <<'NODE'
import { readFileSync } from "node:fs";
const [statusFile, changedFile, beadsFile, ledgerFile] = process.argv.slice(2);
const status = JSON.parse(readFileSync(statusFile, "utf8"));
const changed = JSON.parse(readFileSync(changedFile, "utf8"));
const beadsRaw = JSON.parse(readFileSync(beadsFile, "utf8"));
const beads = Array.isArray(beadsRaw) ? beadsRaw : Array.isArray(beadsRaw.data) ? beadsRaw.data : beadsRaw.tasks ?? [];
const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(status.execution?.grant === "none", `execution grant remains active: ${status.execution?.grant}`);
assert(status.task?.current === "none", `current task remains selected: ${status.task?.current}`);
assert(status.workflow?.checkpoint === "cancelled", `workflow checkpoint is ${status.workflow?.checkpoint}`);
assert(beads.length === 1, `expected one Beads task after cancellation, got ${beads.length}`);
assert(beads[0].status !== "closed", `Beads task was closed instead of retained: ${beads[0].status}`);
const metadataRoots = [".atelier", ".beads", ".dolt", ".codesearch", ".octocode"];
const paths = [...(changed.paths ?? [])]
  .filter((path) => !metadataRoots.some((root) => path === root || path.startsWith(`${root}/`)))
  .sort();
assert(JSON.stringify(paths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]),
  `unexpected retained source changes: ${JSON.stringify(paths)}`);
const kinds = new Set(ledger.map((event) => event.kind));
for (const kind of ["execution.paused", "execution.resumed", "execution.revoked", "workflow.cancelled"]) {
  assert(kinds.has(kind), `missing ledger event ${kind}`);
}
assert(!kinds.has("task.closed"), "task was closed during cancellation test");
NODE
  pass "Step 5 preserved source changes and the open task while revoking execution"
}

verify_step_preconditions() {
  local step="$1" name="$2"
  verify_workspace_release "$name"
  is_test_mode && return 0
  if [[ "$step" == 5 ]]; then
    local root="$GUIDED_ROOT/control"
    local status_file="$EVIDENCE_DIR/guided-control/pre-step5-status.json"
    mkdir -p "$(dirname "$status_file")"
    (
      source "$root/env.sh"
      cd "$root/repo"
      node ./bin/atlr.mjs status --json >"$status_file"
    )
    json_assert "$status_file" '
      assert(data.workflow?.mode === "act", `step 5 requires act mode, got ${data.workflow?.mode}`);
      assert(data.execution?.grant !== "none", "step 5 requires an active execution grant from step 4");
      assert(typeof data.task?.current === "string" && data.task.current !== "none", "step 5 requires the active task from step 4");
    '
  fi
}

run_step_objective_checks() {
  local step="$1"
  if [[ "${ATELIER_GUIDED_TEST_SKIP_OBJECTIVE:-0}" == 1 ]]; then
    case "$step" in
      2) restore_all_checkpoints policy-git ;;
      3) restore_all_checkpoints policy-jj ;;
    esac
    return 0
  fi
  local before_rc=0 restore_rc=0 after_rc=0
  case "$step" in
    1) return 0 ;;
    2)
      set +e
      (verify_policy_git_before_restore); before_rc=$?
      (restore_all_checkpoints policy-git); restore_rc=$?
      collect_workspace policy-git
      (verify_policy_git_after_restore); after_rc=$?
      set -e
      (( before_rc == 0 && restore_rc == 0 && after_rc == 0 ))
      ;;
    3)
      set +e
      (verify_policy_jj_before_restore); before_rc=$?
      (restore_all_checkpoints policy-jj); restore_rc=$?
      collect_workspace policy-jj
      (verify_policy_jj_after_restore); after_rc=$?
      set -e
      (( before_rc == 0 && restore_rc == 0 && after_rc == 0 ))
      ;;
    4) verify_control_approval ;;
    5) verify_control_cancellation ;;
    *) fail "unknown guided step: $step" ;;
  esac
}

restore_all_checkpoints() {
  local name="$1"
  local root="$GUIDED_ROOT/$name"
  local repo="$root/repo"
  local list="$EVIDENCE_DIR/guided-$name/recovery-before-restore.json"
  local restore_log="$EVIDENCE_DIR/guided-$name/recovery-restore.txt"
  mkdir -p "$(dirname "$list")"
  (
    source "$root/env.sh"
    cd "$repo"
    node ./bin/atlr.mjs recovery list --json >"$list"
    : >"$restore_log"
    local checkpoint_count=0
    while IFS=$'\t' read -r checkpoint_id provider paths; do
      [[ -n "$checkpoint_id" ]] || continue
      checkpoint_count=$((checkpoint_count + 1))
      printf '\nCheckpoint %s\n' "$checkpoint_id"
      printf '  Provider: %s\n' "$provider"
      printf '  Paths: %s\n' "$paths"
      {
        printf 'Checkpoint %s\nProvider: %s\nPaths: %s\n' "$checkpoint_id" "$provider" "$paths"
        node ./bin/atlr.mjs recovery restore "$checkpoint_id"
        printf '\n'
      } | tee -a "$restore_log"
    done < <(node --input-type=module - "$list" <<'NODE'
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const list = Array.isArray(data) ? data : data.checkpoints ?? [];
for (const checkpoint of list) {
  const provider = checkpoint.repositoryState?.provider ?? "unknown";
  const paths = Array.isArray(checkpoint.paths) ? checkpoint.paths.join(", ") : "none";
  process.stdout.write(`${checkpoint.id}\t${provider}\t${paths}\n`);
}
NODE
    )
    if [[ "$checkpoint_count" -eq 0 ]]; then
      printf 'No recovery checkpoints were created.\n' | tee -a "$restore_log"
      if [[ "${ATELIER_GUIDED_TEST_ALLOW_EMPTY_RECOVERY:-0}" == 1 ]]; then
        return 0
      fi
      return 1
    fi

    case "$name" in
      policy-git)
        [[ "$(cat manual-policy/dirty-delete.txt)" == $'dirty original\ndirty uncommitted' ]] \
          || fail "dirty tracked checkpoint did not restore exact contents"
        [[ "$(cat manual-policy/untracked-delete.txt)" == 'untracked contents' ]] \
          || fail "untracked checkpoint did not restore exact contents"
        [[ "$(cat manual-policy/ignored-delete.txt)" == 'ignored contents' ]] \
          || fail "ignored checkpoint did not restore exact contents"
        [[ ! -e manual-policy/typed-created.txt ]] \
          || fail "investigate-mode typed create unexpectedly succeeded"
        [[ "$(cat manual-policy/clean-edit.txt)" == 'clean edit' ]] \
          || fail "investigate-mode typed edit unexpectedly changed clean-edit.txt"
        printf 'Verified restored paths:\n  manual-policy/dirty-delete.txt\n  manual-policy/untracked-delete.txt\n  manual-policy/ignored-delete.txt\n'
        ;;
      policy-jj)
        [[ "$(cat manual-policy/dirty-delete.txt)" == $'jj dirty original\njj uncommitted contents' ]] \
          || fail "Jujutsu checkpoint did not restore exact dirty working-copy contents"
        printf 'Verified restored path:\n  manual-policy/dirty-delete.txt\n'
        ;;
    esac
  )
}

step_metadata() {
  local step="$1"
  case "$step" in
    1) printf '%s\t%s\t%s\t%s\n' intel-jj 'Jujutsu footer and persistent Markdown reports' jj ready ;;
    2) printf '%s\t%s\t%s\t%s\n' policy-git 'Git recoverability and consequence-based prompts' git disabled ;;
    3) printf '%s\t%s\t%s\t%s\n' policy-jj 'Jujutsu native checkpoint and restoration' jj disabled ;;
    4) printf '%s\t%s\t%s\t%s\n' control 'Plan review, rejection, and idle approval' jj disabled ;;
    5) printf '%s\t%s\t%s\t%s\n' control 'Stop, pause, resume, and cancellation' jj disabled ;;
    *) fail "unknown guided step: $step" ;;
  esac
}

remove_recorded_steps() {
  [[ -f "$RESULTS_FILE" ]] || return 0
  local steps_csv="$1"
  local temporary="$RESULTS_FILE.tmp"
  awk -F '\t' -v steps="$steps_csv" '
    BEGIN {
      count = split(steps, values, ",")
      for (i = 1; i <= count; i += 1) removed[values[i]] = 1
    }
    !($1 in removed)
  ' "$RESULTS_FILE" >"$temporary"
  mv "$temporary" "$RESULTS_FILE"
}

prepare_single_step() {
  local step="$1"
  local automated_repo="$RUN_ROOT/repo"
  [[ -d "$automated_repo/.git" ]] || fail "automated repository is missing: $automated_repo"
  SOURCE_REPO="$(git -C "$automated_repo" remote get-url origin)"
  SOURCE_REPO="$(canonical_dir "$SOURCE_REPO")"
  verify_source_release "$SOURCE_REPO"
  mkdir -p "$GUIDED_ROOT" "$EVIDENCE_DIR"
  case "$step" in
    1) prepare_intel_jj; remove_recorded_steps 1 ;;
    2) prepare_policy_git; remove_recorded_steps 2 ;;
    3) prepare_policy_jj; remove_recorded_steps 3 ;;
    4) prepare_control; remove_recorded_steps 4,5 ;;
    5) fail "step 5 depends on the approved task created in step 4; run '$PROGRAM retry 4'" ;;
    *) fail "unknown guided step: $step" ;;
  esac
  write_guides
  : >"$GUIDED_ROOT/.prepared"
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
  verify_step_preconditions "$step" "$name"
  banner "$step" "$title" "$repo" "$vcs" "$intel" "$guide"
  local out="$EVIDENCE_DIR/guided-$name"
  local pi_stderr="$out/pi.stderr"
  mkdir -p "$out"
  : >"$pi_stderr"
  printf '%s\n' 'mise run launch -- -ne --no-session' >"$out/pi-command.txt"
  TUI_TERMINAL_DIRTY=1
  set +e
  (
    source "$root/env.sh"
    cd "$repo"
    # Every guided step gets a fresh Pi transcript. Atelier workflow state remains
    # durable through its external ledger, so step 5 can continue step 4 safely.
    mise run launch -- -ne --no-session 2> >(tee "$pi_stderr" >&2)
  )
  local rc=$?
  set -e
  printf '%s\n' "$rc" >"$out/pi-exit-status.txt"
  restore_terminal
  if [[ "$rc" -eq 0 ]]; then
    clear_screen
  else
    printf '\nPi exited unexpectedly with status %s. The terminal was left visible for diagnostics.\n' "$rc" >&2
    if [[ -s "$pi_stderr" ]]; then
      printf 'Captured stderr: %s\n' "$pi_stderr" >&2
    fi
  fi
  printf 'Pi exited with status %s. Collecting authoritative evidence...\n' "$rc"
  collect_workspace "$name"

  local objective_rc=0
  if [[ "$rc" -eq 0 ]]; then
    set +e
    (run_step_objective_checks "$step")
    objective_rc=$?
    set -e
  else
    objective_rc=1
  fi

  if [[ "$rc" -ne 0 ]]; then
    record_automatic_failure "$step" "$title" "Pi exited with status $rc"
  elif [[ "$objective_rc" -ne 0 ]]; then
    record_automatic_failure "$step" "$title" "authoritative evidence did not satisfy the step contract"
  else
    record_result "$step" "$title"
  fi
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
  else
    # Guide files are disposable presentation artifacts. Refresh them on every
    # guided run so corrected instructions repair an existing workspace without
    # resetting prepared repositories or recorded manual outcomes.
    write_guides
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

retry_step() {
  load_run
  local step="${1:-}"
  [[ "$step" =~ ^[1-5]$ ]] || fail "usage: $PROGRAM retry STEP (STEP must be 1-5)"
  log "recreate guided step $step from the current Atelier source"
  prepare_single_step "$step"

  local metadata name title vcs intel
  metadata="$(step_metadata "$step")"
  IFS=$'\t' read -r name title vcs intel <<<"$metadata"
  launch_step "$step" "$name" "$title" "$vcs" "$intel"
  archive_evidence >/dev/null
  log "guided step $step retry complete"
  if [[ "$step" -lt 5 ]]; then
    printf 'Continue with: %s guided %s\n' "$PROGRAM" "$((step + 1))"
  fi
}

archive_evidence() {
  load_run
  local output="$RUN_ROOT/atelier-guided-verification-evidence.tar.xz"
  tar -C "$RUN_ROOT" -cJf "$output" evidence guided env.sh 2>/dev/null || tar -C "$RUN_ROOT" -cJf "$output" evidence guided
  printf '%s\n' "$output"
}

show_status() {
  load_run
  printf 'harness:  %s\n' "$HARNESS_VERSION"
  printf 'expected: %s\n' "$EXPECTED_ATELIER_VERSION"
  printf 'run:      %s\n' "$RUN_ROOT"
  printf 'guided:   %s\n' "$GUIDED_ROOT"
  printf 'results:  %s\n' "$RESULTS_FILE"
  [[ -s "$RESULTS_FILE" ]] && { printf '\n'; column -t -s $'\t' "$RESULTS_FILE" 2>/dev/null || cat "$RESULTS_FILE"; }
  for name in intel-jj policy-git policy-jj control; do
    [[ -d "$GUIDED_ROOT/$name/repo" ]] && printf '%-12s %s\n' "$name" "$GUIDED_ROOT/$name/repo"
  done
  return 0
}

run_automated() {
  local source="${1:-$PWD}"
  source="$(canonical_dir "$source")"
  require_command mise
  require_command node
  require_command git
  verify_source_release "$source"
  ensure_live_toolchain "$source"
  if [[ "${ATELIER_GUIDED_SKIP_CHECK:-0}" != 1 ]]; then
    log "deterministic source gate"
    (cd "$source" && mise run check)
  else
    printf 'WARNING: skipping deterministic source gate because ATELIER_GUIDED_SKIP_CHECK=1\n'
  fi
  log "automated live acceptance"
  (
    cd "$source"
    # Keep the project-pinned Node, Jujutsu, codesearch, and other mise tools in
    # PATH for the complete child harness, including after it changes into its
    # freshly cloned acceptance repository.
    mise exec -- "$source/scripts/live-acceptance.sh" all "$source"
  )
  load_run
  prepare_manual
}

fresh_run() {
  local source="${1:-$PWD}"
  source="$(canonical_dir "$source")"
  require_command git
  require_command node
  require_command mise
  verify_source_release "$source"
  # Preflight all live dependencies before deleting prior evidence.
  ensure_live_toolchain "$source"

  purge_old_runs

  # Prevent stale shell exports from forcing the live harness back into a removed run.
  unset ATELIER_MANUAL_ROOT ATLR_REPO ATLR_STATE_HOME ATLR_USER_CONFIG

  run_automated "$source"
  run_guided 1
}

main() {
  case "${1:-}" in
    fresh) shift; fresh_run "${1:-$PWD}" ;;
    purge) purge_old_runs ;;
    all) shift; run_automated "${1:-$PWD}"; run_guided 1 ;;
    automated) shift; run_automated "${1:-$PWD}" ;;
    prepare) prepare_manual ;;
    guided) shift; run_guided "${1:-1}" ;;
    retry) shift; retry_step "${1:-}" ;;
    status) show_status ;;
    archive) archive_evidence ;;
    -h|--help|help|'') usage ;;
    *) usage >&2; fail "unknown command: ${1:-}" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  activate_mise_environment "$@"
  main "$@"
fi
