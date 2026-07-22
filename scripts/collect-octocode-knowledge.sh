#!/usr/bin/env bash
set -uo pipefail
ROOT="${1:-$PWD}"
OUT="${2:-$ROOT/.atelier/octocode-probe}"
ARCHIVE="${3:-$ROOT/atelier-octocode-knowledge.tar.xz}"
mkdir -p "$OUT"
run() {
  local name="$1"; shift
  echo "== $name =="
  "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr"
  printf '%s\n' "$?" >"$OUT/$name.status"
}
if ! command -v octocode >/dev/null 2>&1; then
  cat >"$OUT/SUMMARY.md" <<'TXT'
# Octocode Probe

Octocode was not found after `mise install`. The development manifest expects Muvon Octocode 0.14.0; capture `mise install` output and rerun `mise run collect:octocode`.
TXT
  tar -cJf "$ARCHIVE" -C "$(dirname "$OUT")" "$(basename "$OUT")"
  echo "Octocode knowledge archive ready at: $ARCHIVE"
  exit 1
fi
run version octocode --version
run help octocode --help
run mcp_help octocode mcp --help
run index octocode index
run providers node --no-warnings --experimental-strip-types apps/cli/src/main.ts code providers --json
run status node --no-warnings --experimental-strip-types apps/cli/src/main.ts code status --provider octocode --json
run search node --no-warnings --experimental-strip-types apps/cli/src/main.ts code search --provider octocode --mode semantic --json "Where is code provider selection implemented?"
run related node --no-warnings --experimental-strip-types apps/cli/src/main.ts code related --provider octocode --path packages/core/src/core.ts --kind imports,dependencies,references --depth 1 --limit 20 --json packages/core/src/core.ts
node --no-warnings --experimental-strip-types scripts/probe-octocode-mcp.ts "$ROOT" >"$OUT/mcp_contract.stdout" 2>"$OUT/mcp_contract.stderr"
printf '%s\n' "$?" >"$OUT/mcp_contract.status"
cat >"$OUT/SUMMARY.md" <<TXT
# Octocode Probe

- Version exit: $(cat "$OUT/version.status")
- Index exit: $(cat "$OUT/index.status")
- Provider status exit: $(cat "$OUT/status.status")
- Search exit: $(cat "$OUT/search.status")
- Relationships exit: $(cat "$OUT/related.status")
- MCP contract exit: $(cat "$OUT/mcp_contract.status")
TXT
if command -v shasum >/dev/null 2>&1; then (cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS); fi
tar -cJf "$ARCHIVE" -C "$(dirname "$OUT")" "$(basename "$OUT")"
echo "Octocode knowledge archive ready at: $ARCHIVE"
