#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/atelier-path-alias.XXXXXX")"
REAL_TMP="$TEMP_PARENT/real"
ALIAS_TMP="$TEMP_PARENT/alias"

cleanup() {
  rm -rf "$TEMP_PARENT"
}
trap cleanup EXIT

if [[ "${OS:-}" == "Windows_NT" ]]; then
  printf 'Canonical temporary-path alias regression is not applicable on Windows.\n'
  exit 0
fi

mkdir -p "$REAL_TMP"
ln -s "$REAL_TMP" "$ALIAS_TMP"

TEST_FILES=(
  tests/acceptance-workflow.test.ts
  tests/canonical-path-end-to-end.test.ts
  tests/codesearch-provider.test.ts
  tests/interactive-performance.test.ts
  tests/jujutsu-repository-provider.test.ts
  tests/manual-acceptance-corrections.test.ts
  tests/octocode-provider.test.ts
  tests/pi-extension.test.ts
  tests/repository-path.test.ts
  tests/repository-provider-correctness.test.ts
  tests/workspace-policy.test.ts
)

cd "$ROOT"
TMPDIR="$ALIAS_TMP" \
TMP="$ALIAS_TMP" \
TEMP="$ALIAS_TMP" \
TERM="${TERM:-dumb}" \
  node --no-warnings --experimental-strip-types \
  --import ./tests/test-environment.ts \
  --test --test-concurrency=4 \
  "${TEST_FILES[@]}"
