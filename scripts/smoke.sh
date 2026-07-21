#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.atelier"
cat > "$tmp/.atelier/config.json" <<'JSON'
{
  "planPath": ".atelier/PLAN.md",
  "databasePath": ".atelier/atelier.db",
  "taskProvider": "memory"
}
JSON

git -C "$tmp" init --quiet
node "$project_root/bin/atlr.mjs" --root "$tmp" init >/dev/null
cp "$project_root/examples/PLAN.md" "$tmp/.atelier/PLAN.md"
node "$project_root/bin/atlr.mjs" --root "$tmp" plan parse --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" policy command "git status --short" >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" state --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" code providers --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" code status --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" status --json >/dev/null

echo "Atelier CLI smoke test passed"
