#!/usr/bin/env bash
# fresh-vault.sh — wipe <path> and re-run `void-os init` against it.
# After VOS-143: thin wrapper. Plugin owns the daemon now; init copies plugin
# artifacts (no symlink override needed); gh push is opt-in only.
set -euo pipefail

usage() {
  cat <<EOF
usage: fresh-vault.sh <path> [--yes]

  <path>   vault directory to wipe + re-init
  --yes    skip the destructive-action confirmation
EOF
}

PATH_ARG=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)  [ -z "$PATH_ARG" ] || { echo "extra arg: $1" >&2; exit 2; }
        PATH_ARG="$1"; shift ;;
  esac
done
[ -n "$PATH_ARG" ] || { usage >&2; exit 2; }

# Repo root = parent of scripts/ dir. Use the repo's own bin/void-os so this
# works without a global install (matches the worktree's CLI behavior).
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd -P )"
VOID_OS_BIN="${VOID_OS_BIN:-$REPO_ROOT/bin/void-os}"
[ -x "$VOID_OS_BIN" ] || { echo "fresh-vault: void-os binary not executable at $VOID_OS_BIN" >&2; exit 2; }

# Canonicalize + safety guards (kept from old script).
VAULT="$(cd "$(dirname "$PATH_ARG")" 2>/dev/null && pwd)/$(basename "$PATH_ARG")"
[ "$VAULT" = "$HOME" ] && { echo "refusing to wipe \$HOME" >&2; exit 1; }
[ "$VAULT" = "/" ]    && { echo "refusing to wipe /" >&2; exit 1; }

if [ "$YES" -ne 1 ]; then
  read -r -p "wipe $VAULT and re-init? type 'yes' to confirm: " ans
  [ "$ans" = "yes" ] || { echo "aborted" >&2; exit 1; }
fi

rm -rf "$VAULT"
"$VOID_OS_BIN" init --non-interactive --vault "$VAULT"
echo "fresh-vault: ready at $VAULT"
echo "fresh-vault: open in Obsidian to start chatting (plugin will auto-spawn daemon)"
