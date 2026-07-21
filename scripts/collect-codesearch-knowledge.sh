#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-$PWD}
OUT=${2:-$ROOT/.atelier/codesearch-probe}
"$ROOT/scripts/probe-codesearch.sh" "$ROOT" "$OUT"
node --experimental-strip-types "$ROOT/scripts/update-codesearch-fixtures.ts" "$OUT" "$OUT/normalized-fixtures"
printf '\nKnowledge bundle ready at: %s\n' "$OUT"
printf 'Attach the entire directory as a tar archive:\n'
printf '  tar -cJf atelier-codesearch-knowledge.tar.xz -C %q %q\n' "$(dirname "$OUT")" "$(basename "$OUT")"
