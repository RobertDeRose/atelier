#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-$PWD}
OUT=${2:-$ROOT/.atelier/codesearch-probe}
ARCHIVE=${3:-$ROOT/atelier-codesearch-knowledge.tar.xz}

probe_status=0
"$ROOT/scripts/probe-codesearch.sh" "$ROOT" "$OUT" || probe_status=$?

# Collection is evidence gathering, so always normalize and package whatever the
# probe produced. The final exit status still reflects provider conformance.
fixture_status=0
node --experimental-strip-types   "$ROOT/scripts/update-codesearch-fixtures.ts"   "$OUT"   "$OUT/normalized-fixtures" || fixture_status=$?

archive_status=0
if command -v tar >/dev/null 2>&1; then
  mkdir -p "$(dirname "$ARCHIVE")"
  tar -cJf "$ARCHIVE" -C "$(dirname "$OUT")" "$(basename "$OUT")" || archive_status=$?
else
  printf 'warning: tar is unavailable; knowledge archive was not created
' >&2
  archive_status=1
fi

printf '
Knowledge bundle ready at: %s
' "$OUT"
if [ "$archive_status" -eq 0 ]; then
  printf 'Knowledge archive ready at: %s
' "$ARCHIVE"
else
  printf 'Create the archive manually with:
'
  printf '  tar -cJf atelier-codesearch-knowledge.tar.xz -C %q %q
' "$(dirname "$OUT")" "$(basename "$OUT")"
fi

if [ -f "$OUT/CONFORMANCE.md" ]; then
  printf '
Conformance summary:
'
  sed -n '1,8p' "$OUT/CONFORMANCE.md"
fi

if [ "$fixture_status" -ne 0 ]; then
  printf 'fixture normalization failed with exit %s
' "$fixture_status" >&2
fi
if [ "$probe_status" -ne 0 ]; then
  printf 'codesearch conformance reported failures (exit %s); the complete evidence archive was still created
' "$probe_status" >&2
fi

if [ "$fixture_status" -ne 0 ]; then exit "$fixture_status"; fi
if [ "$archive_status" -ne 0 ]; then exit "$archive_status"; fi
exit "$probe_status"
