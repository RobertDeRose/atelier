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
skip() {
  local name="$1" reason="$2"
  echo "== $name =="
  printf '%s\n' "$reason" >"$OUT/$name.stderr"
  : >"$OUT/$name.stdout"
  printf '78\n' >"$OUT/$name.status"
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
run config_show octocode config --show
run models_help octocode models --help
run models_list octocode models list
run stats_before octocode stats
run embedding_environment node --no-warnings --experimental-strip-types scripts/inspect-octocode-environment.ts "$OUT/config_show.stdout" "$OUT/stats_before.stdout"
if [ "$(cat "$OUT/embedding_environment.status")" = "0" ]; then
  run index octocode index
else
  skip index "Embedding provider prerequisites are missing; indexing was skipped to avoid a long unsuccessful run."
fi
run stats_after octocode stats
run adapter_index node --no-warnings --experimental-strip-types apps/cli/src/main.ts code index --provider octocode --json=true
run mcp_contract node --no-warnings --experimental-strip-types scripts/probe-octocode-mcp.ts "$ROOT"
run providers node --no-warnings --experimental-strip-types apps/cli/src/main.ts code providers --json=true
run status node --no-warnings --experimental-strip-types apps/cli/src/main.ts code status --provider octocode --json=true
run search node --no-warnings --experimental-strip-types apps/cli/src/main.ts code search "Where is code provider selection implemented?" --provider octocode --mode semantic --focus source --json=true
run symbols node --no-warnings --experimental-strip-types apps/cli/src/main.ts code symbols "OctocodeProvider" --provider octocode --json=true
if grep -q '"name": "graphrag"' "$OUT/mcp_contract.stdout"; then
  run related node --no-warnings --experimental-strip-types apps/cli/src/main.ts code related packages/core/src/core.ts --provider octocode --path packages/core/src/core.ts --kind imports,dependencies,references --depth 1 --limit 20 --json=true
else
  printf '%s\n' '{"skipped":true,"reason":"graphrag was not advertised by Octocode"}' >"$OUT/related.stdout"
  : >"$OUT/related.stderr"
  printf '0\n' >"$OUT/related.status"
fi
node --no-warnings --experimental-strip-types scripts/summarize-octocode-probe.ts "$OUT" >"$OUT/conformance.stdout" 2>"$OUT/conformance.stderr"
conformance_status=$?
printf '%s\n' "$conformance_status" >"$OUT/conformance.status"
cat >"$OUT/SUMMARY.md" <<TXT
# Octocode Probe

- Version exit: $(cat "$OUT/version.status")
- Embedding preflight exit: $(cat "$OUT/embedding_environment.status")
- Index exit: $(cat "$OUT/index.status")
- Stats exit: $(cat "$OUT/stats_after.status")
- Adapter index exit: $(cat "$OUT/adapter_index.status")
- Provider status exit: $(cat "$OUT/status.status")
- Search exit: $(cat "$OUT/search.status")
- Symbols exit: $(cat "$OUT/symbols.status")
- Relationships exit: $(cat "$OUT/related.status")
- MCP contract exit: $(cat "$OUT/mcp_contract.status")
- Conformance exit: $conformance_status
TXT
if command -v shasum >/dev/null 2>&1; then (cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS); fi
tar -cJf "$ARCHIVE" -C "$(dirname "$OUT")" "$(basename "$OUT")"
echo "Octocode knowledge archive ready at: $ARCHIVE"
if [ -f "$OUT/CONFORMANCE.md" ]; then
  echo
  echo "Conformance summary:"
  sed -n '1,12p' "$OUT/CONFORMANCE.md"
fi
exit "$conformance_status"
