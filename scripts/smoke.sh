#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
if [[ -n "${ATLR_SMOKE_TMP_LOG:-}" ]]; then printf '%s\n' "$tmp" > "$ATLR_SMOKE_TMP_LOG"; fi
trust_store="${tmp}.trust.json"
state_home="${tmp}.state"
cleanup() { rm -rf "$tmp" "$trust_store" "$state_home"; }
export ATLR_TRUST_STORE="$trust_store"
export ATLR_STATE_HOME="$state_home"
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

mkdir -p "$tmp/.atelier"
cat > "$tmp/editor.mjs" <<'JS'
#!/usr/bin/env node
process.exit(0);
JS
chmod +x "$tmp/editor.mjs"
cat > "$tmp/.atelier/config.json" <<JSON
{
  "planPath": ".atelier/PLAN.md",
  "taskProvider": "memory",
  "repositoryProvider": "git",
  "codeProvider": "disabled",
  "editor": "$tmp/editor.mjs"
}
JSON

git -C "$tmp" init --quiet
node "$project_root/bin/atlr.mjs" --root "$tmp" trust --yes >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" init >/dev/null
cp "$project_root/examples/PLAN.md" "$tmp/.atelier/PLAN.md"
node "$project_root/bin/atlr.mjs" --root "$tmp" plan parse --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" plan "smoke the guarded workflow" >/dev/null
review_json="$(node "$project_root/bin/atlr.mjs" --root "$tmp" review --json)"
printf '%s' "$review_json" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const value = JSON.parse(input); if (!value.manualEdit?.accepted || !Array.isArray(value.reconciliation?.operations)) process.exit(1); });'
node "$project_root/bin/atlr.mjs" --root "$tmp" policy command "git status --short" >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" state --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" code providers --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" code status --json >/dev/null
node "$project_root/bin/atlr.mjs" --root "$tmp" status --json >/dev/null

echo "Atelier CLI smoke test passed"
