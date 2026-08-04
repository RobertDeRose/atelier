#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
install_directory="${ATLR_WRAPPER_INSTALL_DIR:-/usr/local/bin}"
wrapper_path="$install_directory/atlr"
temporary_wrapper="$(mktemp "${TMPDIR:-/tmp}/atlr-wrapper.XXXXXX")"
cleanup() {
  rm -f -- "$temporary_wrapper"
}
trap cleanup EXIT

printf -v quoted_repository_root '%q' "$repository_root"
cat >"$temporary_wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ATELIER_REPOSITORY=$quoted_repository_root
workspace_root="\$(pwd -P)"
if [[ ! -d "\$ATELIER_REPOSITORY" || ! -f "\$ATELIER_REPOSITORY/bin/atlr.mjs" ]]; then
  printf 'atlr: Atelier checkout is unavailable: %s\n' "\$ATELIER_REPOSITORY" >&2
  exit 1
fi
if ! command -v mise >/dev/null 2>&1; then
  printf 'atlr: mise is required to run the pinned Atelier runtime.\n' >&2
  exit 1
fi

if [[ "\${1:-}" == "launch" ]]; then
  shift
  exec env ATELIER_REPOSITORY="\$ATELIER_REPOSITORY" MISE_CONFIG_FILE="\$ATELIER_REPOSITORY/mise.toml" mise run launch "\$workspace_root" -- "\$@"
fi

exec mise exec --cd "\$ATELIER_REPOSITORY" -- node "\$ATELIER_REPOSITORY/bin/atlr.mjs" --root "\$workspace_root" "\$@"
EOF
chmod 0755 "$temporary_wrapper"

install_wrapper() {
  install -d -m 0755 "$install_directory" 2>/dev/null && install -m 0755 "$temporary_wrapper" "$wrapper_path"
}

if ! install_wrapper; then
  if ! command -v sudo >/dev/null 2>&1; then
    printf 'atlr: cannot write %s and sudo is unavailable.\n' "$wrapper_path" >&2
    exit 1
  fi
  if ! sudo -n install -d -m 0755 "$install_directory" || ! sudo -n install -m 0755 "$temporary_wrapper" "$wrapper_path"; then
    printf 'atlr: cannot install %s without an interactive sudo prompt.\n' "$wrapper_path" >&2
    exit 1
  fi
fi

printf 'Installed atlr wrapper: %s\n' "$wrapper_path"
