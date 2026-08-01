#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

PROGRAM="$(basename "$0")"
HARNESS_VERSION="32"
POINTER_FILE="${ATELIER_ACCEPTANCE_POINTER:-$HOME/.atelier-manual-current}"
PI_TIMEOUT_SECONDS="${ATELIER_PI_TIMEOUT_SECONDS:-600}"
SOURCE_REPO=""

log()  { printf '\n==> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage:
  $PROGRAM all [SOURCE_REPO]
  $PROGRAM automated [SOURCE_REPO]
  $PROGRAM resume code
  $PROGRAM resume shell
  $PROGRAM resume restart
  $PROGRAM prepare-tui [SOURCE_REPO]
  $PROGRAM archive
  $PROGRAM status

Commands:
  all          Run the headless live gate, then prepare the two TUI-only workspaces.
  automated    Run the complete non-interactive golden path in a persistent clone.
  resume code  Reuse the current persistent run and continue at the code-intelligence gate.
               On success, finish the automated path and prepare the TUI-only workspaces.
  resume shell Reuse a run that completed typed implementation and stopped at the
               headless JSON-mode shell-denial gate. Continue without redoing prior work.
  resume restart
               Reuse a run that passed the headless shell gate and stopped while
               verifying restart reconstruction. Continue without repeating the shell gate.
  prepare-tui  Prepare a Pi-resource-trust independence clone and a workflow-control clone.
  archive      Archive the current run's evidence directory.
  status       Print the current run location and repository states.

Environment:
  ATELIER_MANUAL_ROOT          Reuse or choose a specific persistent run directory.
  ATELIER_ACCEPTANCE_POINTER   Pointer file (default: ~/.atelier-manual-current).
  ATELIER_PI_TIMEOUT_SECONDS   Timeout for each Pi headless run (default: 600).
  ATELIER_MODEL                Optional Pi --model value for headless prompts.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

canonical_dir() {
  (cd "$1" && pwd -P)
}

sha256_tree() {
  local root="$1"
  if command -v shasum >/dev/null 2>&1; then
    find "$root" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done
  elif command -v sha256sum >/dev/null 2>&1; then
    find "$root" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
      sha256sum "$file"
    done
  else
    fail "neither shasum nor sha256sum is available"
  fi
}

json_value() {
  local file="$1"
  local expression="$2"
  node --input-type=module - "$file" "$expression" <<'NODE'
import { readFileSync } from "node:fs";
const [file, expression] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, "utf8"));
const value = Function("data", `return (${expression});`)(data);
if (value === undefined || value === null) process.exit(2);
if (typeof value === "object") process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
NODE
}

json_assert() {
  local file="$1"
  local body="$2"
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

jsonl_tool_assert() {
  local file="$1"
  local required_csv="$2"
  local forbidden_csv="${3:-}"
  node --input-type=module - "$file" "$required_csv" "$forbidden_csv" <<'NODE'
import { readFileSync } from "node:fs";
const [file, requiredCsv, forbiddenCsv] = process.argv.slice(2);
const required = requiredCsv.split(",").map((value) => value.trim()).filter(Boolean);
const forbidden = forbiddenCsv.split(",").map((value) => value.trim()).filter(Boolean);
const tools = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  // Pi JSON mode emits actual executions as top-level tool_execution_start events.
  // Do not recursively inspect message, result, state, or agent_end payloads: those can
  // legitimately contain historical Atelier execution evidence with nested toolName fields.
  if (event?.type === "tool_execution_start" && typeof event.toolName === "string") {
    tools.push(event.toolName);
  }
}
for (const name of required) {
  if (!tools.includes(name)) {
    throw new Error(`required Pi tool_execution_start was not observed: ${name}; observed: ${tools.join(", ")}`);
  }
}
for (const name of forbidden) {
  if (tools.includes(name)) {
    throw new Error(`forbidden Pi tool_execution_start was observed: ${name}; observed: ${tools.join(", ")}`);
  }
}
NODE
}

jsonl_tool_assert_any() {
  local file="$1"
  local any_csv="$2"
  local forbidden_csv="${3:-}"
  node --input-type=module - "$file" "$any_csv" "$forbidden_csv" <<'NODE'
import { readFileSync } from "node:fs";
const [file, anyCsv, forbiddenCsv] = process.argv.slice(2);
const any = anyCsv.split(",").map((value) => value.trim()).filter(Boolean);
const forbidden = forbiddenCsv.split(",").map((value) => value.trim()).filter(Boolean);
const tools = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === "tool_execution_start" && typeof event.toolName === "string") {
    tools.push(event.toolName);
  }
}
if (!any.some((name) => tools.includes(name))) {
  throw new Error(`none of the accepted Pi tool_execution_start events were observed (${any.join(", ")}); observed: ${tools.join(", ")}`);
}
for (const name of forbidden) {
  if (tools.includes(name)) {
    throw new Error(`forbidden Pi tool_execution_start was observed: ${name}; observed: ${tools.join(", ")}`);
  }
}
NODE
}


jsonl_assert_no_unexpected_errors() {
  local file="$1"
  local allowed_error_tools="${2:-}"
  node --input-type=module - "$file" "$allowed_error_tools" <<'NODE'
import { readFileSync } from "node:fs";
const [file, allowedCsv] = process.argv.slice(2);
const allowed = new Set(allowedCsv.split(",").map((value) => value.trim()).filter(Boolean));
const failures = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === "tool_execution_end" && event.isError === true && !allowed.has(event.toolName)) {
    failures.push(`${event.toolName ?? "unknown"}: ${JSON.stringify(event.result ?? event.error ?? "tool error")}`);
  }
}
if (failures.length > 0) throw new Error(`unexpected Pi tool errors:\n${failures.join("\n")}`);
NODE
}

jsonl_assert_implementation_errors() {
  local file="$1"
  local allowed_path="$2"
  node --input-type=module - "$file" "$allowed_path" <<'NODE'
import { readFileSync } from "node:fs";
const [file, allowedPath] = process.argv.slice(2);
const failures = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type !== "tool_execution_end" || event.isError !== true) continue;
  const serialized = JSON.stringify(event.result ?? event.error ?? "tool error");
  const expectedMissingRead = event.toolName === "read"
    && serialized.includes("ENOENT")
    && serialized.includes(allowedPath);
  if (!expectedMissingRead) failures.push(`${event.toolName ?? "unknown"}: ${serialized}`);
}
if (failures.length > 0) throw new Error(`unexpected Pi tool errors:\n${failures.join("\n")}`);
NODE
}

jsonl_assert_no_forced_continuation() {
  local file="$1"
  node --input-type=module - "$file" <<'NODE'
import { readFileSync } from "node:fs";
const counts = { agentStart: 0, agentEnd: 0, settled: 0 };
let completionGuard = false;
for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event; try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === "agent_start") counts.agentStart += 1;
  if (event?.type === "agent_end") counts.agentEnd += 1;
  if (event?.type === "agent_settled") counts.settled += 1;
  if (JSON.stringify(event).includes("[Atelier completion guard]")) completionGuard = true;
}
if (counts.agentStart !== 1 || counts.agentEnd !== 1 || counts.settled > 1 || completionGuard) {
  throw new Error(`forced continuation detected: ${JSON.stringify({ ...counts, completionGuard })}`);
}
NODE
}

jsonl_parser_self_check() {
  local fixture
  fixture="$(mktemp -t atelier-jsonl-parser.XXXXXX)"
  cat >"$fixture" <<'JSONL'
{"type":"session","version":3,"id":"self-check","cwd":"/tmp"}
{"type":"tool_execution_start","toolCallId":"state-1","toolName":"atlr_state","args":{}}
{"type":"tool_execution_end","toolCallId":"state-1","toolName":"atlr_state","result":{"executionEvidence":[{"toolName":"write"},{"toolName":"edit"},{"toolName":"bash"}]},"isError":false}
{"type":"agent_end","messages":[{"role":"toolResult","details":{"toolName":"write"}}]}
JSONL
  jsonl_tool_assert "$fixture" "atlr_state" "bash,write,edit"
  rm -f "$fixture"
}


jsonl_assert_string() {
  local file="$1"
  local needle="$2"
  node --input-type=module - "$file" "$needle" <<'NODE'
import { readFileSync } from "node:fs";
const [file, needle] = process.argv.slice(2);
const strings = [];
const visit = (value) => {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  for (const item of Object.values(value)) visit(item);
};
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  try { visit(JSON.parse(line)); } catch { /* preserve diagnostics in the raw log */ }
}
if (!strings.some((value) => value.includes(needle))) {
  throw new Error(`JSONL string was not observed: ${needle}`);
}
NODE
}

run_with_timeout() {
  local seconds="$1"
  local logfile="$2"
  shift 2

  set +e
  (
    "$@" </dev/null >"$logfile" 2>&1
  ) &
  local pid=$!
  (
    sleep "$seconds"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 3
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  local watchdog=$!

  wait "$pid"
  local status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  set -e

  if [[ "$status" -ne 0 ]]; then
    tail -n 80 "$logfile" >&2 || true
    fail "command failed or timed out with status $status; log: $logfile"
  fi
}

load_current_workspace() {
  [[ -f "$POINTER_FILE" ]] || fail "no current acceptance run; expected pointer: $POINTER_FILE"
  local root
  root="$(cat "$POINTER_FILE")"
  [[ -f "$root/env.sh" ]] || fail "missing environment file: $root/env.sh"
  # shellcheck disable=SC1090
  source "$root/env.sh"
  cd "$ATLR_REPO"
  ATLR_BIN=(node "$ATLR_REPO/bin/atlr.mjs")
  EVIDENCE_DIR="$ATELIER_MANUAL_ROOT/evidence"
  mkdir -p "$EVIDENCE_DIR"
}

write_environment() {
  local manual_root="$1"
  local repo="$2"
  cat >"$manual_root/env.sh" <<EOF
export ATELIER_MANUAL_ROOT="$manual_root"
export ATLR_REPO="$repo"
export ATLR_STATE_HOME="$manual_root/state"
export ATLR_USER_CONFIG="$manual_root/user-config.json"
export VISUAL="\${VISUAL:-hx}"
export EDITOR="\${EDITOR:-\$VISUAL}"

atlr() {
  node "\$ATLR_REPO/bin/atlr.mjs" "\$@"
}
EOF
}

source_version() {
  node -p "require('$SOURCE_REPO/package.json').version"
}

create_automated_workspace() {
  SOURCE_REPO="$(canonical_dir "${1:-$PWD}")"
  require_command git
  require_command node
  require_command mise
  require_command jj
  require_command bd
  require_command codesearch
  require_command pi
  require_command python3

  [[ -f "$SOURCE_REPO/package.json" ]] || fail "not an Atelier checkout: $SOURCE_REPO"
  [[ -z "$(git -C "$SOURCE_REPO" status --short)" ]] || fail "source checkout is dirty: $SOURCE_REPO"

  local version
  version="$(source_version)"
  local expected_tag="v$version"
  local actual_tag
  actual_tag="$(git -C "$SOURCE_REPO" describe --tags --exact-match 2>/dev/null || true)"
  [[ "$actual_tag" == "$expected_tag" ]] || fail "source HEAD is not tagged $expected_tag (found: ${actual_tag:-none})"

  local manual_root="${ATELIER_MANUAL_ROOT:-$HOME/workspace/scratch/atelier-manual-$(date +%Y%m%d-%H%M%S)}"
  [[ ! -e "$manual_root" ]] || fail "manual root already exists: $manual_root"
  mkdir -p "$manual_root"
  git clone --no-hardlinks "$SOURCE_REPO" "$manual_root/repo"
  printf '%s\n' "$manual_root" >"$POINTER_FILE"
  write_environment "$manual_root" "$manual_root/repo"

  load_current_workspace
  jj git init --colocate
  mise install
  mise run install

  {
    printf 'Repository: %s\n' "$ATLR_REPO"
    printf 'Source: %s\n' "$SOURCE_REPO"
    printf 'HEAD: %s\n' "$(git rev-parse HEAD)"
    printf 'Tag: %s\n' "$(git describe --tags --exact-match 2>/dev/null || echo none)"
    printf 'Atelier: %s\n' "$("${ATLR_BIN[@]}" --version)"
    for tool in node jj bd codesearch pi mise; do
      printf '%-12s %s\n' "$tool" "$("$tool" --version 2>&1 | head -1)"
    done
  } | tee "$EVIDENCE_DIR/tool-versions.txt"

  pass "created persistent automated workspace at $ATELIER_MANUAL_ROOT"
}

verify_workspace_policy() {
  log "observational doctor and startup workspace policy"
  find .atelier -type f -print 2>/dev/null | LC_ALL=C sort >"$EVIDENCE_DIR/files-before-doctor.txt"
  "${ATLR_BIN[@]}" doctor >"$EVIDENCE_DIR/doctor.json"
  find .atelier -type f -print 2>/dev/null | LC_ALL=C sort >"$EVIDENCE_DIR/files-after-doctor.txt"
  diff -u "$EVIDENCE_DIR/files-before-doctor.txt" "$EVIDENCE_DIR/files-after-doctor.txt" >"$EVIDENCE_DIR/doctor-file-diff.txt" || {
    cat "$EVIDENCE_DIR/doctor-file-diff.txt" >&2
    fail "doctor changed project files"
  }
  [[ ! -e "$ATLR_STATE_HOME" ]] || fail "doctor created runtime state"
  json_assert "$EVIDENCE_DIR/doctor.json" '
    assert(data.observational === true, "doctor was not observational");
    assert(data.workspace?.policy === "workspace_recoverability", `unexpected policy: ${data.workspace?.policy}`);
    assert(data.workspace?.source === "startup_cwd", `unexpected workspace source: ${data.workspace?.source}`);
    assert(typeof data.workspace?.root === "string" && data.workspace.root.length > 0, "workspace root missing");
    assert(!("trust" in data), "legacy Atelier trust state is still exposed");
  '
  [[ "$(canonical_dir "$ATLR_REPO")" == "$(json_value "$EVIDENCE_DIR/doctor.json" 'data.workspace.root')" ]] \
    || fail "doctor workspace root does not match the canonical startup directory"
  if "${ATLR_BIN[@]}" trust status >"$EVIDENCE_DIR/legacy-trust-command.txt" 2>&1; then
    fail "legacy Atelier trust command is still available"
  fi
  pass "doctor remained observational and startup established the immutable workspace without Atelier trust"
}

initialize_and_baseline() {
  log "idempotent initialization, validation configuration, and clean setup baseline"
  "${ATLR_BIN[@]}" init --beads >"$EVIDENCE_DIR/init-first.json"
  sha256_tree .beads >"$EVIDENCE_DIR/beads-before-second-init.sha256"
  "${ATLR_BIN[@]}" init --beads >"$EVIDENCE_DIR/init-second.json"
  sha256_tree .beads >"$EVIDENCE_DIR/beads-after-second-init.sha256"
  diff -u "$EVIDENCE_DIR/beads-before-second-init.sha256" "$EVIDENCE_DIR/beads-after-second-init.sha256" \
    >"$EVIDENCE_DIR/beads-second-init.diff" || {
      cat "$EVIDENCE_DIR/beads-second-init.diff" >&2
      fail "second atlr init --beads changed provider files"
    }

  bd where --json >"$EVIDENCE_DIR/beads-where.json" 2>"$EVIDENCE_DIR/beads-where.stderr"
  bd list --json >"$EVIDENCE_DIR/beads-before-plan.json" 2>"$EVIDENCE_DIR/beads-list.stderr"
  json_assert "$EVIDENCE_DIR/beads-before-plan.json" 'assert(Array.isArray(data) && data.length === 0, "Beads was not empty before approval");'

  local permissions
  permissions="$(stat -f '%Lp' .beads 2>/dev/null || stat -c '%a' .beads)"
  [[ "$permissions" == "700" ]] || fail ".beads permissions are $permissions, expected 700"
  [[ ! -e .atelier/atelier.db ]] || fail "repository-local .atelier/atelier.db exists"
  find "$ATLR_STATE_HOME" -name atelier.db -print >"$EVIDENCE_DIR/runtime-databases.txt"
  [[ -s "$EVIDENCE_DIR/runtime-databases.txt" ]] || fail "external Atelier database was not found"

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

  "${ATLR_BIN[@]}" config validate --json >"$EVIDENCE_DIR/config-validation.json"
  json_assert "$EVIDENCE_DIR/config-validation.json" '
    assert(data.valid === true, `configuration invalid: ${JSON.stringify(data.issues)}`);
    assert(data.workspace?.repositories?.length === 1, "expected one repository snapshot");
    const snapshot = data.workspace.repositories[0].snapshot;
    assert(snapshot.vcs === "jj", "Jujutsu provider was not selected");
    assert(snapshot.headCommit && snapshot.headCommit !== "unknown", "missing head commit");
    assert(snapshot.changeId && snapshot.operationId, "missing Jujutsu revision identity");
  '

  local product_changes
  product_changes="$(git status --short -- apps packages tests || true)"
  [[ -z "$product_changes" ]] || fail "setup modified product source before planning: $product_changes"

  jj status >"$EVIDENCE_DIR/jj-status-before-baseline.txt"
  jj diff --stat >"$EVIDENCE_DIR/jj-diff-before-baseline.txt"
  jj commit -m "test: establish Atelier automated acceptance baseline"
  jj status >"$EVIDENCE_DIR/jj-status-after-baseline.txt"
  jj log -r @- --no-graph -T 'commit_id ++ "\n"' >"$EVIDENCE_DIR/setup-baseline-commit.txt"
  [[ -z "$(git status --short)" ]] || fail "workspace was not clean after setup baseline"
  pass "initialization was idempotent and the setup baseline is clean"
}

verify_shell_policy() {
  log "generic shell authorization boundary"
  local commands=(
    'env rm -rf build'
    'git tag v1.0.0'
    'cat <(rm -rf build)'
    'sed --in-place s/a/b/ src/file.ts'
  )
  local index=0
  for command in "${commands[@]}"; do
    local output="$EVIDENCE_DIR/policy-$index.json"
    "${ATLR_BIN[@]}" policy command "$command" >"$output"
    json_assert "$output" '
        assert(data.decision?.result === "ask", `shell decision was ${data.decision?.result}`);
      assert(typeof data.decision?.reason === "string" && data.decision.reason.length > 0, "missing concrete consequence explanation");
    '
    index=$((index + 1))
  done
  pass "all adversarial shell forms ask once for their concrete unrecoverable consequence"
}

capture_codesearch_diagnostics() {
  local suffix="$1"
  codesearch doctor >"$EVIDENCE_DIR/codesearch-doctor-$suffix.txt" 2>&1 || true
  codesearch stats >"$EVIDENCE_DIR/codesearch-stats-$suffix.txt" 2>&1 || true
  {
    printf 'database_exists=%s\n' "$([[ -e .codesearch.db ]] && printf true || printf false)"
    [[ ! -e .codesearch.db ]] || du -sh .codesearch.db
    printf 'selection_state_exists=%s\n' "$([[ -e .atelier/codesearch-index-state.json ]] && printf true || printf false)"
  } >"$EVIDENCE_DIR/codesearch-files-$suffix.txt" 2>&1
}

run_live_code_index() {
  capture_codesearch_diagnostics before-index
  set +e
  "${ATLR_BIN[@]}" code index --json \
    >"$EVIDENCE_DIR/code-index.json" \
    2>"$EVIDENCE_DIR/code-index.stderr"
  local status=$?
  set -e
  capture_codesearch_diagnostics after-index
  if [[ "$status" -ne 0 ]]; then
    cat "$EVIDENCE_DIR/code-index.stderr" >&2 || true
    printf '\n--- codesearch doctor ---\n' >&2
    cat "$EVIDENCE_DIR/codesearch-doctor-after-index.txt" >&2 || true
    printf '\n--- codesearch stats ---\n' >&2
    cat "$EVIDENCE_DIR/codesearch-stats-after-index.txt" >&2 || true
    fail "Atelier codesearch indexing failed with status $status; diagnostics: $EVIDENCE_DIR"
  fi
}

verify_code_intelligence() {
  log "live codesearch through the Atelier CLI"
  run_live_code_index
  "${ATLR_BIN[@]}" code status --json >"$EVIDENCE_DIR/code-status.json"
  "${ATLR_BIN[@]}" code search "Where is the authoritative task closure predicate implemented?" --json \
    >"$EVIDENCE_DIR/code-search-closure.json"
  "${ATLR_BIN[@]}" code symbols AtelierCore --json >"$EVIDENCE_DIR/code-symbols-atelier-core.json"

  json_assert "$EVIDENCE_DIR/code-index.json" 'assert(data.state === "ready", `code index is ${data.state}`);'
  json_assert "$EVIDENCE_DIR/code-status.json" '
    assert(data.status?.available === true && data.status?.healthy === true, "codesearch is not healthy");
    assert(data.status?.indexState === "ready", `index state is ${data.status?.indexState}`);
  '
  json_assert "$EVIDENCE_DIR/code-search-closure.json" '
    assert(data.results?.some((item) => item.path === "packages/core/src/core.ts"), "closure search missed packages/core/src/core.ts");
  '
  json_assert "$EVIDENCE_DIR/code-symbols-atelier-core.json" '
    const first = data.results?.[0];
    assert(first?.path === "packages/core/src/core.ts", "AtelierCore definition did not rank first");
    assert(first?.symbol === "class AtelierCore", `unexpected AtelierCore display signature: ${first?.symbol}`);
    assert(data.inventory?.resolvedSymbols?.includes("AtelierCore"), "AtelierCore was not recorded as a canonical resolved symbol");
    assert(!data.inventory?.unresolvedSymbols?.includes("AtelierCore"), "AtelierCore remained unresolved");
    assert(!data.inventory?.resolvedSymbols?.some((name) => /^(class |function |block \(|imports \()/.test(name)), "provider display labels leaked into canonical inventory symbols");
  '

  local model_args=()
  [[ -z "${ATELIER_MODEL:-}" ]] || model_args=(--model "$ATELIER_MODEL")
  run_with_timeout "$PI_TIMEOUT_SECONDS" "$EVIDENCE_DIR/pi-code-tools.jsonl" \
    "${ATLR_BIN[@]}" launch -ne --mode json -p --no-session --no-approve \
    "${model_args[@]}" \
    --tools atlr_code_status,atlr_code_search,atlr_code_symbols \
    "Call atlr_code_status exactly once. Then call atlr_code_search once with a focused query containing the exact identifier AtelierCore. Finally call atlr_code_symbols for AtelierCore exactly once. Use no other tools and identify the class definition path."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-code-tools.jsonl" "atlr_code_status,atlr_code_search,atlr_code_symbols" "bash,write,edit"
  jsonl_assert_no_unexpected_errors "$EVIDENCE_DIR/pi-code-tools.jsonl"
  jsonl_assert_string "$EVIDENCE_DIR/pi-code-tools.jsonl" "packages/core/src/core.ts"
  jsonl_assert_string "$EVIDENCE_DIR/pi-code-tools.jsonl" "class AtelierCore"
  pass "codesearch and the Pi model-facing code tools are reachable headlessly"
}

write_plan_fixture() {
  local fixture="$EVIDENCE_DIR/approved-plan.md"
  cat >"$fixture" <<'PLAN'
# Automated Acceptance Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Add a stable Atelier product-name constant
<!-- atlr:task {"id":"ATLR-001","priority":1,"type":"task","execution":{"writePaths":["packages/core/src/version.ts","tests/version.test.ts"],"allowDependencyChanges":false,"validations":["manual-acceptance"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Expose a stable Atelier product-name constant and verify it independently of release-version metadata.

### Scope

- Add `ATELIER_PRODUCT_NAME = "Atelier"` to `packages/core/src/version.ts`.
- Add `tests/version.test.ts`.
- Verify `ATELIER_PRODUCT_NAME` and `ATELIER_VERSION`.

### Out of scope

- Changing the release version.
- Changing package metadata.
- Changing CLI behavior.
- Adding dependencies.

### Depends on

- None

### Validation

- Run the configured `manual-acceptance` focused validation.

### Completion criteria

- `ATELIER_PRODUCT_NAME` is exported with the value `Atelier`.
- Existing `ATELIER_VERSION` behavior remains unchanged.
- `tests/version.test.ts` passes through the configured validation.

### Notes

- Use typed repository file tools.
- Shell effects remain governed independently by workspace containment and exact recoverability.
PLAN

  local editor="$ATELIER_MANUAL_ROOT/replace-plan-editor.sh"
  cat >"$editor" <<EOF
#!/bin/sh
set -eu
cp "$fixture" "\$1"
EOF
  chmod +x "$editor"
  printf '%s\n' "$editor"
}

pty_reject_approval() {
  local approval_id="$1"
  local digest="$2"
  local logfile="$3"
  python3 - "$logfile" "${ATLR_BIN[@]}" approve --approval "$approval_id" --digest "$digest" <<'PY'
import os
import pty
import select
import sys
import time

logfile = sys.argv[1]
command = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

buffer = bytearray()
sent = False
deadline = time.monotonic() + 60
with open(logfile, "wb") as log:
    while True:
        if time.monotonic() > deadline:
            os.kill(pid, 15)
            raise SystemExit("timed out waiting for approval prompt")
        readable, _, _ = select.select([fd], [], [], 0.2)
        if readable:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if chunk:
                log.write(chunk)
                log.flush()
                buffer.extend(chunk)
                if not sent and b"[y/N]" in buffer[-8192:]:
                    os.write(fd, b"n\n")
                    sent = True
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            if not sent:
                raise SystemExit("approval prompt was not observed")
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise SystemExit(f"approval rejection command failed: {status}")
            break
PY
}

review_reject_and_approve() {
  log "deterministic ManualEdit, zero-mutation rejection, and exact approval"
  local objective='Add an exported ATELIER_PRODUCT_NAME constant with the value "Atelier" to packages/core/src/version.ts and add tests/version.test.ts verifying ATELIER_PRODUCT_NAME and ATELIER_VERSION. Do not change release metadata or any other behavior.'
  "${ATLR_BIN[@]}" plan "$objective" >"$EVIDENCE_DIR/plan-start.txt"
  local editor
  editor="$(write_plan_fixture)"
  ATLR_EDITOR="$editor" "${ATLR_BIN[@]}" review --json >"$EVIDENCE_DIR/plan-review.json"
  "${ATLR_BIN[@]}" plan parse --json >"$EVIDENCE_DIR/plan-parse.json"

  json_assert "$EVIDENCE_DIR/plan-review.json" '
    assert(data.manualEdit?.accepted === true, "ManualEdit was not accepted");
    assert(!data.diagnostics?.some((item) => item.level === "error"), "reviewed plan has parser errors");
    assert(data.reconciliation?.conflicts?.length === 0, "reconciliation has conflicts");
  '
  json_assert "$EVIDENCE_DIR/plan-parse.json" '
    assert(data.tasks?.length === 1, "expected one atomic task");
    const execution = data.tasks[0].execution;
    assert(JSON.stringify(execution.writePaths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]), "wrong write paths");
    assert(execution.allowDependencyChanges === false, "dependency changes were permitted");
    assert(JSON.stringify(execution.validations) === JSON.stringify(["manual-acceptance"]), "wrong validation contract");
    assert(execution.allowFullSuite === false, "full suite was permitted");
    assert(execution.allowLocalChange === true, "local change was not permitted");
  '

  "${ATLR_BIN[@]}" plan prepare --json >"$EVIDENCE_DIR/approval-prepared-reject.json"
  local rejection_id rejection_digest
  rejection_id="$(json_value "$EVIDENCE_DIR/approval-prepared-reject.json" 'data.approval.id')"
  rejection_digest="$(json_value "$EVIDENCE_DIR/approval-prepared-reject.json" 'data.approval.reconciliationDigest')"
  pty_reject_approval "$rejection_id" "$rejection_digest" "$EVIDENCE_DIR/approval-rejection-terminal.txt"

  bd list --json >"$EVIDENCE_DIR/beads-after-rejection.json" 2>"$EVIDENCE_DIR/beads-after-rejection.stderr"
  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-after-rejection.json"
  json_assert "$EVIDENCE_DIR/beads-after-rejection.json" 'assert(Array.isArray(data) && data.length === 0, "rejection mutated Beads");'
  json_assert "$EVIDENCE_DIR/status-after-rejection.json" '
    assert(data.workflow?.mode === "plan", `rejection left plan mode: ${data.workflow?.mode}`);
    assert(data.task?.current === "none", `rejection selected a task: ${data.task?.current}`);
  '

  "${ATLR_BIN[@]}" plan prepare --json >"$EVIDENCE_DIR/approval-prepared-accept.json"
  local approval_id approval_digest
  approval_id="$(json_value "$EVIDENCE_DIR/approval-prepared-accept.json" 'data.approval.id')"
  approval_digest="$(json_value "$EVIDENCE_DIR/approval-prepared-accept.json" 'data.approval.reconciliationDigest')"
  "${ATLR_BIN[@]}" approve --approval "$approval_id" --digest "$approval_digest" --yes --json \
    >"$EVIDENCE_DIR/approval-accepted.json"

  bd list --json >"$EVIDENCE_DIR/beads-after-approval.json" 2>"$EVIDENCE_DIR/beads-after-approval.stderr"
  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-after-approval.json"
  json_assert "$EVIDENCE_DIR/beads-after-approval.json" 'assert(Array.isArray(data) && data.length === 1, "approval did not create exactly one task");'
  json_assert "$EVIDENCE_DIR/status-after-approval.json" '
    assert(data.workflow?.mode === "act", `approval did not enter act mode: ${data.workflow?.mode}`);
    assert(typeof data.task?.current === "string" && data.task.current !== "none", "approval did not activate a task");
  '
  json_assert "$EVIDENCE_DIR/status-after-approval.json" '
    assert(data.execution?.grant !== "none", "approval did not create an execution grant");
    assert(data.execution?.constraints === 1, `expected one reviewed task constraint, got ${data.execution?.constraints}`);
    assert(data.workflow?.mode === "act", `workflow mode is ${data.workflow?.mode}`);
  '
  json_assert "$EVIDENCE_DIR/plan-parse.json" '
    const execution = data.tasks[0].execution;
    assert(JSON.stringify(execution.writePaths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]), "reviewed write constraints drifted");
    assert(JSON.stringify(execution.validations) === JSON.stringify(["manual-acceptance"]), "reviewed validation constraints drifted");
  '
  pass "rejection was zero-mutation and acceptance installed only the reviewed task constraints"
}

run_pi_json() {
  local logfile="$1"
  local tools="$2"
  local prompt="$3"
  local model_args=()
  [[ -z "${ATELIER_MODEL:-}" ]] || model_args=(--model "$ATELIER_MODEL")
  run_with_timeout "$PI_TIMEOUT_SECONDS" "$logfile" \
    "${ATLR_BIN[@]}" launch -ne --mode json -p --no-session --no-approve \
    "${model_args[@]}" --tools "$tools" "$prompt"
}

verify_current_validation() {
  local file="$1"
  json_assert "$file" '
    assert(Array.isArray(data), "evidence output is not an array");
    assert(data.some((item) => item.name === "manual-acceptance" && item.status === "passed" && item.stale === false), "no current passing manual-acceptance evidence");
  '
}

run_headless_implementation() {
  log "headless Pi typed implementation"
  local version
  version="$(node -p "require('./package.json').version")"
  local implementation_prompt
  implementation_prompt=$(cat <<EOF
Implement the active Atelier task now. Use only read, edit, write, and atlr_state. Do not use Bash, do not run validation, do not commit, and do not close the task. Add exactly one exported constant named ATELIER_PRODUCT_NAME with value "Atelier" to packages/core/src/version.ts. Create tests/version.test.ts using node:test and node:assert/strict; import ATELIER_PRODUCT_NAME and ATELIER_VERSION and assert they equal "Atelier" and "$version". Stop after those two approved source changes.
EOF
)
  run_pi_json "$EVIDENCE_DIR/pi-implementation.jsonl" "read,edit,write,atlr_state" "$implementation_prompt"
  jsonl_tool_assert_any "$EVIDENCE_DIR/pi-implementation.jsonl" "write,edit" "bash,atlr_validate,atlr_commit,atlr_task_close"
  jsonl_assert_implementation_errors "$EVIDENCE_DIR/pi-implementation.jsonl" "$ATLR_REPO/tests/version.test.ts"

  grep -q 'export const ATELIER_PRODUCT_NAME = "Atelier"' packages/core/src/version.ts \
    || fail "Pi did not add ATELIER_PRODUCT_NAME"
  [[ -f tests/version.test.ts ]] || fail "Pi did not create tests/version.test.ts"
  grep -q 'ATELIER_PRODUCT_NAME' tests/version.test.ts || fail "version test does not check product name"
  grep -q 'ATELIER_VERSION' tests/version.test.ts || fail "version test does not check release version"

  "${ATLR_BIN[@]}" changed --json >"$EVIDENCE_DIR/changed-after-implementation.json"
  json_assert "$EVIDENCE_DIR/changed-after-implementation.json" '
    const paths = [...data.paths].sort();
    assert(JSON.stringify(paths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]), `unexpected changed paths: ${paths}`);
  '
}

verify_headless_shell_block() {
  log "JSON-mode outside-workspace shell request fails closed without UI"
  local outside_marker="$ATELIER_MANUAL_ROOT/headless-shell-ran"
  rm -f "$outside_marker"
  run_pi_json "$EVIDENCE_DIR/pi-headless-shell-block.jsonl" "bash" \
    "Use Bash to run exactly: printf 'headless-shell-ran\n' > '$outside_marker'. Do not use any other tool."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-headless-shell-block.jsonl" "bash" "write,edit"
  [[ ! -e "$outside_marker" ]] || fail "outside-workspace shell command executed in JSON mode"
  jsonl_assert_string "$EVIDENCE_DIR/pi-headless-shell-block.jsonl" \
    "outside the Atelier workspace"
  jsonl_assert_string "$EVIDENCE_DIR/pi-headless-shell-block.jsonl" \
    "Interactive approval is unavailable in json mode."
  jsonl_assert_no_forced_continuation "$EVIDENCE_DIR/pi-headless-shell-block.jsonl"
  pass "headless JSON-mode outside-workspace write was denied with the concrete Atelier policy reason"
}

continue_headless_after_shell() {
  log "Pi restart reconstructs the active execution"
  run_pi_json "$EVIDENCE_DIR/pi-restart-state.jsonl" "atlr_state" \
    "Call atlr_state exactly once and report the active task ID and next action. Use no other tool."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-restart-state.jsonl" "atlr_state" "bash,write,edit"

  local task_id
  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-before-premature-close.json"
  task_id="$(json_value "$EVIDENCE_DIR/status-before-premature-close.json" 'data.task.current')"
  printf '%s\n' "$task_id" >"$EVIDENCE_DIR/active-task-id.txt"
  set +e
  "${ATLR_BIN[@]}" task close "$task_id" --reason "premature automated acceptance" \
    >"$EVIDENCE_DIR/premature-close.stdout" 2>"$EVIDENCE_DIR/premature-close.stderr"
  local close_status=$?
  set -e
  [[ "$close_status" -ne 0 ]] || fail "task closed before validation, diff review, and local change"

  log "deterministic focused validation"
  "${ATLR_BIN[@]}" validate plan --json >"$EVIDENCE_DIR/validation-plan-first.json"
  "${ATLR_BIN[@]}" validate focused --json >"$EVIDENCE_DIR/validation-focused-first.json"
  "${ATLR_BIN[@]}" evidence --json >"$EVIDENCE_DIR/evidence-current-first.json"
  verify_current_validation "$EVIDENCE_DIR/evidence-current-first.json"

  log "typed edit makes validation evidence stale"
  local old_title new_title
  old_title="$(node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs";
const text = readFileSync("tests/version.test.ts", "utf8");
const match = text.match(/test\((['"])(.*?)\1/);
if (!match) process.exit(2);
process.stdout.write(match[2]);
NODE
)"
  new_title="$old_title (stale evidence probe)"
  run_pi_json "$EVIDENCE_DIR/pi-stale-edit.jsonl" "edit" \
    "Use the edit tool exactly once in tests/version.test.ts. Replace the exact text '$old_title' with '$new_title'. Do not read, write, validate, commit, close, or use Bash."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-stale-edit.jsonl" "edit" "read,write,bash,atlr_validate,atlr_commit,atlr_task_close,atlr_state"
  grep -Fq "$new_title" tests/version.test.ts || fail "typed stale-evidence edit did not apply the exact title replacement"
  "${ATLR_BIN[@]}" evidence --json >"$EVIDENCE_DIR/evidence-stale.json"
  json_assert "$EVIDENCE_DIR/evidence-stale.json" '
    assert(data.some((item) => item.name === "manual-acceptance" && item.stale === true), "validation did not become stale after source edit");
  '

  log "rerun focused validation and create the scoped local change"
  "${ATLR_BIN[@]}" validate focused --json >"$EVIDENCE_DIR/validation-focused-second.json"
  "${ATLR_BIN[@]}" evidence --json >"$EVIDENCE_DIR/evidence-current-second.json"
  verify_current_validation "$EVIDENCE_DIR/evidence-current-second.json"

  run_pi_json "$EVIDENCE_DIR/pi-commit.jsonl" "atlr_commit,atlr_state" \
    "Call atlr_commit exactly once with message 'test: add automated Atelier product-name acceptance', then call atlr_state. Do not use Bash or raw VCS commands."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-commit.jsonl" "atlr_commit,atlr_state" "bash"
  "${ATLR_BIN[@]}" changed --json >"$EVIDENCE_DIR/changed-after-commit.json"
  json_assert "$EVIDENCE_DIR/changed-after-commit.json" 'assert(Array.isArray(data.paths) && data.paths.length === 0, `approved source paths remain dirty: ${data.paths}`);'
  "${ATLR_BIN[@]}" ledger tail --limit 80 --json >"$EVIDENCE_DIR/ledger-after-commit.json"
  json_assert "$EVIDENCE_DIR/ledger-after-commit.json" '
    const event = data.find((item) => item.kind === "repository.change_created");
    assert(event, "repository.change_created evidence is missing");
    const paths = [...event.payload.changedPaths].sort();
    assert(JSON.stringify(paths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]), `scoped commit included unexpected paths: ${paths}`);
  '
  "${ATLR_BIN[@]}" evidence --json >"$EVIDENCE_DIR/evidence-current-after-commit.json"
  verify_current_validation "$EVIDENCE_DIR/evidence-current-after-commit.json"

  log "exact diff review and typed task closure"
  "${ATLR_BIN[@]}" repo review-diff --json >"$EVIDENCE_DIR/final-diff-review.json"
  run_pi_json "$EVIDENCE_DIR/pi-close.jsonl" "atlr_task_close,atlr_state" \
    "Call atlr_task_close exactly once with reason 'completed and verified', then call atlr_state. Use no other tool."
  jsonl_tool_assert "$EVIDENCE_DIR/pi-close.jsonl" "atlr_task_close,atlr_state" "bash,write,edit"

  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-after-close.json"
  "${ATLR_BIN[@]}" task show "$task_id" --json >"$EVIDENCE_DIR/task-after-close.json"
  bd list --json >"$EVIDENCE_DIR/beads-after-close.json" 2>"$EVIDENCE_DIR/beads-after-close.stderr" || true
  "${ATLR_BIN[@]}" evidence --json >"$EVIDENCE_DIR/evidence-after-close.json"
  "${ATLR_BIN[@]}" ledger tail --limit 120 --json >"$EVIDENCE_DIR/ledger-after-close.json"
  jj status --color never >"$EVIDENCE_DIR/jj-status-after-close.txt"

  json_assert "$EVIDENCE_DIR/status-after-close.json" '
    assert(data.task?.current === "none", `task remained active after closure: ${data.task?.current}`);
    assert(data.workflow?.mode !== "act", "workflow remained in act mode after closure");
  '
  json_assert "$EVIDENCE_DIR/task-after-close.json" '
    const task = data.task ?? data;
    assert(task.status === "closed", `task status is ${task.status}`);
  '
  grep -Fxq "The working copy has no changes." "$EVIDENCE_DIR/jj-status-after-close.txt" \
    || fail "whole-repository closure left Jujutsu changes; see $EVIDENCE_DIR/jj-status-after-close.txt"
  jsonl_assert_no_unexpected_errors "$EVIDENCE_DIR/pi-close.jsonl"
  pass "headless typed implementation, validation, scoped commit, diff review, repository finalization, and closure completed"
}

run_headless_execution() {
  run_headless_implementation
  verify_headless_shell_block
  continue_headless_after_shell
}

write_aux_env() {
  local root="$1"
  local repo="$2"
  cat >"$root/env.sh" <<EOF
export ATELIER_MANUAL_ROOT="$root"
export ATLR_REPO="$repo"
export ATLR_STATE_HOME="$root/state"
export ATLR_USER_CONFIG="$root/user-config.json"
export VISUAL="\${VISUAL:-hx}"
export EDITOR="\${EDITOR:-\$VISUAL}"
EOF
}

prepare_tui_workspaces() {
  load_current_workspace
  SOURCE_REPO="$(git -C "$ATLR_REPO" remote get-url origin)"
  SOURCE_REPO="$(canonical_dir "$SOURCE_REPO")"
  local tui_root="$ATELIER_MANUAL_ROOT/tui"
  rm -rf "$tui_root"
  mkdir -p "$tui_root"

  log "prepare Pi-trust-independence workspace"
  git clone --no-hardlinks "$SOURCE_REPO" "$tui_root/pi-trust/repo"
  write_aux_env "$tui_root/pi-trust" "$tui_root/pi-trust/repo"
  (
    # shellcheck disable=SC1091
    source "$tui_root/pi-trust/env.sh"
    cd "$ATLR_REPO"
    jj git init --colocate
    mise install
    mise run install
  )

  log "prepare workflow-control TUI workspace"
  git clone --no-hardlinks "$SOURCE_REPO" "$tui_root/control/repo"
  write_aux_env "$tui_root/control" "$tui_root/control/repo"
  (
    # shellcheck disable=SC1091
    source "$tui_root/control/env.sh"
    cd "$ATLR_REPO"
    jj git init --colocate
    mise install
    mise run install
    node "$ATLR_REPO/bin/atlr.mjs" init --beads >/dev/null
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
    node "$ATLR_REPO/bin/atlr.mjs" config validate --json >/dev/null
    jj commit -m "test: establish Atelier TUI acceptance baseline"
  )

  cat >"$tui_root/README.txt" <<EOF
Pi trust independence smoke:
  source "$tui_root/pi-trust/env.sh"
  cd "\$ATLR_REPO"
  mise run launch -- -ne

TUI workflow/control smoke:
  source "$tui_root/control/env.sh"
  cd "\$ATLR_REPO"
  mise run launch -- -ne

See docs/LOCAL_ACCEPTANCE.md in the current repository for the interactive checklist.
EOF
  pass "prepared TUI-only workspaces under $tui_root"
}

archive_evidence() {
  load_current_workspace
  local output="$ATELIER_MANUAL_ROOT/atelier-live-acceptance-evidence.tar.xz"
  tar -C "$ATELIER_MANUAL_ROOT" -cJf "$output" \
    evidence env.sh tui 2>/dev/null || \
    tar -C "$ATELIER_MANUAL_ROOT" -cJf "$output" evidence env.sh
  printf '%s\n' "$output"
}

show_status() {
  load_current_workspace
  printf 'Run root: %s\n' "$ATELIER_MANUAL_ROOT"
  printf 'Automated repository: %s\n' "$ATLR_REPO"
  printf 'Evidence: %s\n' "$EVIDENCE_DIR"
  printf '\nAutomated repository state:\n'
  jj status || true
  if [[ -d "$ATELIER_MANUAL_ROOT/tui/pi-trust/repo" ]]; then
    printf '\nTUI Pi-trust-independence workspace: %s\n' "$ATELIER_MANUAL_ROOT/tui/pi-trust/repo"
  fi
  if [[ -d "$ATELIER_MANUAL_ROOT/tui/control/repo" ]]; then
    printf 'TUI control workspace: %s\n' "$ATELIER_MANUAL_ROOT/tui/control/repo"
  fi
}

run_automated() {
  jsonl_parser_self_check
  create_automated_workspace "${1:-$PWD}"
  verify_workspace_policy
  initialize_and_baseline
  verify_shell_policy
  verify_code_intelligence
  review_reject_and_approve
  run_headless_execution
  archive_evidence >/dev/null
  log "automated acceptance complete"
  printf 'Run root: %s\n' "$ATELIER_MANUAL_ROOT"
  printf 'Evidence archive: %s\n' "$ATELIER_MANUAL_ROOT/atelier-live-acceptance-evidence.tar.xz"
}

validate_code_resume_state() {
  load_current_workspace
  log "validate persistent run before resuming at code intelligence"

  [[ -z "$(git status --short)" ]] || {
    git status --short >&2
    fail "current acceptance repository is not at the clean setup baseline"
  }

  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-before-code-resume.json"
  bd list --json >"$EVIDENCE_DIR/beads-before-code-resume.json" 2>"$EVIDENCE_DIR/beads-before-code-resume.stderr"
  json_assert "$EVIDENCE_DIR/status-before-code-resume.json" '
    assert(data.task?.current === "none", "an Atelier task is already active; code-stage resume is unsafe");
    assert(data.workflow?.mode !== "act", "workflow is already in act mode; code-stage resume is unsafe");
  '
  json_assert "$EVIDENCE_DIR/beads-before-code-resume.json" '
    assert(Array.isArray(data) && data.length === 0, "Beads is no longer empty; code-stage resume is unsafe");
  '
  pass "persistent run is still at the clean pre-plan baseline"
}

resume_from_code() {
  jsonl_parser_self_check
  validate_code_resume_state
  verify_code_intelligence
  review_reject_and_approve
  run_headless_execution
  archive_evidence >/dev/null
  log "resumed automated acceptance complete"
  prepare_tui_workspaces
  archive_evidence >/dev/null
  printf 'Run root: %s\n' "$ATELIER_MANUAL_ROOT"
  printf 'Evidence archive: %s\n' "$ATELIER_MANUAL_ROOT/atelier-live-acceptance-evidence.tar.xz"
  printf 'TUI checklist workspaces: %s\n' "$ATELIER_MANUAL_ROOT/tui"
}


validate_shell_resume_state() {
  load_current_workspace
  log "validate persistent run before resuming at the headless shell gate"

  "${ATLR_BIN[@]}" status --json >"$EVIDENCE_DIR/status-before-shell-resume.json"
  "${ATLR_BIN[@]}" changed --json >"$EVIDENCE_DIR/changed-before-shell-resume.json"

  json_assert "$EVIDENCE_DIR/status-before-shell-resume.json" '
    assert(data.workflow?.mode === "act", `workflow mode is ${data.workflow?.mode}, expected act`);
    assert(typeof data.task?.current === "string" && data.task.current !== "none", "no active task exists");
  '
  json_assert "$EVIDENCE_DIR/status-before-shell-resume.json" '
    assert(data.execution?.grant !== "none", "active execution grant is missing");
    assert(data.execution?.constraints === 1, `unexpected reviewed task constraint count: ${data.execution?.constraints}`);
  '
  json_assert "$EVIDENCE_DIR/changed-before-shell-resume.json" '
    const paths = [...data.paths].sort();
    assert(JSON.stringify(paths) === JSON.stringify(["packages/core/src/version.ts", "tests/version.test.ts"]), `unexpected source changes before shell resume: ${paths}`);
  '
  grep -q 'export const ATELIER_PRODUCT_NAME = "Atelier"' packages/core/src/version.ts \
    || fail "ATELIER_PRODUCT_NAME is missing before shell resume"
  [[ -f tests/version.test.ts ]] || fail "tests/version.test.ts is missing before shell resume"
  [[ ! -e "$ATELIER_MANUAL_ROOT/headless-shell-ran" ]] || fail "outside-workspace shell marker already exists; resume is unsafe"
  pass "persistent run retains the approved task and exactly the two typed implementation changes"
}

resume_from_shell() {
  jsonl_parser_self_check
  validate_shell_resume_state
  verify_headless_shell_block
  continue_headless_after_shell
  archive_evidence >/dev/null
  log "resumed automated acceptance from the headless shell gate"
  prepare_tui_workspaces
  archive_evidence >/dev/null
  printf 'Run root: %s\n' "$ATELIER_MANUAL_ROOT"
  printf 'Evidence archive: %s\n' "$ATELIER_MANUAL_ROOT/atelier-live-acceptance-evidence.tar.xz"
  printf 'TUI checklist workspaces: %s\n' "$ATELIER_MANUAL_ROOT/tui"
}


validate_restart_resume_state() {
  validate_shell_resume_state
  log "validate completed headless shell evidence before restart resume"
  local shell_log="$EVIDENCE_DIR/pi-headless-shell-block.jsonl"
  [[ -f "$shell_log" ]] || fail "missing completed shell-gate evidence: $shell_log"
  jsonl_tool_assert "$shell_log" "bash" "write,edit"
  jsonl_assert_string "$shell_log" \
    "outside the Atelier workspace"
  jsonl_assert_string "$shell_log" \
    "Interactive approval is unavailable in json mode."
  [[ ! -e "$ATELIER_MANUAL_ROOT/headless-shell-ran" ]] || fail "outside-workspace shell marker exists; restart resume is unsafe"
  pass "headless shell gate is complete and the active task remains safe to resume"
}

resume_from_restart() {
  jsonl_parser_self_check
  validate_restart_resume_state
  continue_headless_after_shell
  archive_evidence >/dev/null
  log "resumed automated acceptance from restart reconstruction"
  prepare_tui_workspaces
  archive_evidence >/dev/null
  printf 'Run root: %s\n' "$ATELIER_MANUAL_ROOT"
  printf 'Evidence archive: %s\n' "$ATELIER_MANUAL_ROOT/atelier-live-acceptance-evidence.tar.xz"
  printf 'TUI checklist workspaces: %s\n' "$ATELIER_MANUAL_ROOT/tui"
}

main() {
  local command="${1:-}"
  case "$command" in
    all)
      shift
      run_automated "${1:-$PWD}"
      prepare_tui_workspaces
      archive_evidence >/dev/null
      ;;
    automated)
      shift
      run_automated "${1:-$PWD}"
      ;;
    resume)
      shift
      case "${1:-}" in
        code) resume_from_code ;;
        shell) resume_from_shell ;;
        restart) resume_from_restart ;;
        *) fail "usage: $PROGRAM resume code|shell|restart" ;;
      esac
      ;;
    prepare-tui)
      shift || true
      if [[ ! -f "$POINTER_FILE" && -n "${1:-}" ]]; then
        fail "run '$PROGRAM automated ${1}' first; prepare-tui reuses that run root"
      fi
      prepare_tui_workspaces
      archive_evidence >/dev/null
      ;;
    archive)
      archive_evidence
      ;;
    status)
      show_status
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage >&2
      fail "unknown command: $command"
      ;;
  esac
}

main "$@"
