#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-$PWD}
OUT=${2:-$ROOT/.atelier/codesearch-probe}
rm -rf "$OUT"
mkdir -p "$OUT"

log() { printf '%s\n' "$*" | tee -a "$OUT/probe.log"; }
run() {
  local name=$1
  shift
  log "== $name =="
  if "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr"; then
    printf '0\n' >"$OUT/$name.status"
  else
    printf '%s\n' "$?" >"$OUT/$name.status"
  fi
}

command -v codesearch >"$OUT/codesearch.path" || {
  log "codesearch not installed"
  exit 2
}

PROBE_FILE="$ROOT/.atelier/probe-staleness.txt"
trap 'rm -f "$PROBE_FILE"' EXIT

run version codesearch --version
run help codesearch --help
run mcp_help codesearch mcp --help
run index_help codesearch index --help
run search_help codesearch search --help
run codesearch_doctor codesearch doctor
run codesearch_stats codesearch stats
run store_metadata_before node --experimental-strip-types "$ROOT/scripts/inspect-codesearch-store.ts" "$ROOT"
run status_before node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run index node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code index --json
run codesearch_doctor_after codesearch doctor
run codesearch_stats_after codesearch stats
run direct_search codesearch search "where is code provider selection implemented"
run store_metadata node --experimental-strip-types "$ROOT/scripts/inspect-codesearch-store.ts" "$ROOT"
run status_after node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run mcp_contract node --experimental-strip-types "$ROOT/scripts/probe-codesearch-mcp.ts" "$ROOT"
if [ -s "$OUT/mcp_contract.stdout" ]; then
  node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const n of ["semantic","hybrid","literal","fetch","outline","impact"]){const v=x.calls?.[n];if(v!==undefined)fs.writeFileSync(process.argv[2]+"/"+n+".stdout",JSON.stringify(v,null,2)+"\n");}' "$OUT/mcp_contract.stdout" "$OUT"
  for name in semantic hybrid literal fetch outline impact; do [ -f "$OUT/$name.stdout" ] && printf '0\n' >"$OUT/$name.status" || true; done
fi
run search node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "where is code provider selection implemented" --mode auto --json
run search_semantic node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "where is code provider selection implemented" --mode semantic --json
run search_literal node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "CodesearchProvider" --mode lexical --json

printf 'probe staleness marker %s\n' "$(date -u +%FT%TZ)" >"$PROBE_FILE"
run status_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run reindex_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code index --json
run search_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "probe staleness marker" --json
run symbols node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code symbols CodesearchProvider --json
run evaluation node --experimental-strip-types "$ROOT/scripts/evaluate-code.ts" "$ROOT" "$ROOT/evaluation/tasks.json" "$OUT/evaluation"
run conformance node --experimental-strip-types "$ROOT/scripts/summarize-codesearch-probe.ts" "$OUT"

find "$OUT" -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
  shasum -a 256 "$file"
done >"$OUT/SHA256SUMS"
log "Probe complete: $OUT"
exit "$(cat "$OUT/conformance.status")"
