#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
work="$(mktemp -d)"
export ATLR_TRUST_STORE="$work/trust.json"
export ATLR_STATE_HOME="$work/state"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM

source_cli=(node --no-warnings --experimental-strip-types "$root/apps/cli/src/main.ts")

init_git() {
  local target_root="$1"
  git -C "$target_root" init --quiet
  git -C "$target_root" config user.name "Atelier Conformance"
  git -C "$target_root" config user.email "atelier-conformance@example.invalid"
  printf 'conformance\n' >"$target_root/README.md"
  git -C "$target_root" add README.md
  git -C "$target_root" commit --quiet --no-gpg-sign -m "chore: initialize conformance repository"
}

case "$target" in
  jj)
    command -v jj >/dev/null
    repo="$work/jj"
    mkdir -p "$repo/.atelier"
    init_git "$repo"
    (cd "$repo" && jj git init --colocate)
    cat >"$repo/.atelier/config.json" <<'JSON'
{"repositoryProvider":"jj","taskProvider":"none","codeProvider":"disabled"}
JSON
    "${source_cli[@]}" --root "$repo" trust --yes >/dev/null
    output="$("${source_cli[@]}" --root "$repo" repo status --json)"
    node -e 'const x=JSON.parse(process.argv[1]); if(x.provider.provider!=="jj" || x.snapshot.vcs!=="jj") process.exit(1)' "$output"
    ;;
  codesearch)
    command -v codesearch >/dev/null
    mkdir -p "$root/.atelier"
    "${source_cli[@]}" --root "$root" trust --yes >/dev/null
    "$root/scripts/probe-codesearch.sh" "$root" "$work/codesearch-probe"
    ;;
  beads)
    command -v bd >/dev/null
    repo="$work/beads"
    mkdir -p "$repo/.atelier"
    init_git "$repo"
    cat >"$repo/.atelier/config.json" <<'JSON'
{"repositoryProvider":"git","taskProvider":"beads","codeProvider":"disabled"}
JSON
    "${source_cli[@]}" --root "$repo" trust --yes >/dev/null
    output="$("${source_cli[@]}" --root "$repo" init --beads)"
    node -e 'const x=JSON.parse(process.argv[1]); if(!x.beads?.available || !x.beads?.initialized) process.exit(1)' "$output"
    ;;
  pi-bun)
    command -v bun >/dev/null
    command -v pi >/dev/null
    bun --version
    pi --version
    bun -e "await import('${root}/dist/apps/pi-extension/src/index.js')"
    ;;
  *)
    printf 'Usage: %s <jj|codesearch|beads|pi-bun>\n' "$0" >&2
    exit 64
    ;;
esac

printf 'Live %s conformance passed.\n' "$target"
