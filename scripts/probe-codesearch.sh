#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-$PWD}; OUT=${2:-$ROOT/.atelier/codesearch-probe}; mkdir -p "$OUT"
log(){ printf '%s\n' "$*" | tee -a "$OUT/probe.log"; }
run(){ local name=$1; shift; log "== $name =="; { "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr"; echo $? >"$OUT/$name.status"; } || echo $? >"$OUT/$name.status"; }
command -v codesearch >"$OUT/codesearch.path" || { log "codesearch not installed"; exit 2; }
run version codesearch --version
run help codesearch --help
run mcp_help codesearch mcp --help
run index_help codesearch index --help
run status_before node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run index node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code index --json
run status_after node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run search node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "where is code provider selection implemented" --json
PROBE_FILE="$ROOT/.atelier/probe-staleness.txt"
printf 'probe %s\n' "$(date -u +%FT%TZ)" > "$PROBE_FILE"
run status_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code doctor --json
run reindex_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code index --json
run search_after_edit node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code search "probe staleness" --json
rm -f "$PROBE_FILE"
run symbols node --experimental-strip-types "$ROOT/apps/cli/src/main.ts" --root "$ROOT" code symbols CodesearchProvider --json
run evaluation node --experimental-strip-types "$ROOT/scripts/evaluate-code.ts" "$ROOT" "$ROOT/evaluation/tasks.json" "$OUT/evaluation"
find "$OUT" -type f -maxdepth 3 -print0 | sort -z | xargs -0 shasum -a 256 >"$OUT/SHA256SUMS"
log "Probe complete: $OUT"
