#!/usr/bin/env bash
# fresh-vault.sh — wipe + rebuild a void-os vault for manual UX passes.
# Spec: docs/superpowers/specs/2026-05-18-vos-123-fresh-vault-bootstrap-design.md
set -euo pipefail

# --- usage ---------------------------------------------------------------
usage() {
  cat <<'EOF'
usage: scripts/fresh-vault.sh [<path>] [--yes] [--skip-plugin] [--force-stop]

  <path>          target vault dir (default: $HOME/vault-test)
  --yes           skip the typed-'yes' wipe confirmation
  --skip-plugin   skip plugin pre-build and symlink (LXC E2E)
  --force-stop    stop the daemon even if it serves a different vault
  -h, --help      show this message and exit
EOF
}

# --- argv ----------------------------------------------------------------
# Globals populated by parse_args.
PATH_ARG=""
FLAG_YES=0
FLAG_SKIP_PLUGIN=0
FLAG_FORCE_STOP=0

parse_args() {
  local positional_seen=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes)         FLAG_YES=1 ;;
      --skip-plugin) FLAG_SKIP_PLUGIN=1 ;;
      --force-stop)  FLAG_FORCE_STOP=1 ;;
      -h|--help)     usage; exit 0 ;;
      --*)
        echo "fresh-vault: unknown flag: $1" >&2
        usage >&2
        exit 2
        ;;
      *)
        if [ "$positional_seen" -eq 1 ]; then
          echo "fresh-vault: unexpected extra positional arg: $1" >&2
          exit 2
        fi
        PATH_ARG="$1"
        positional_seen=1
        ;;
    esac
    shift
  done
  if [ -z "$PATH_ARG" ]; then
    PATH_ARG="$HOME/vault-test"
  fi
}

# --- main ----------------------------------------------------------------
main() {
  parse_args "$@"
  echo "fresh-vault: path=$PATH_ARG yes=$FLAG_YES skip-plugin=$FLAG_SKIP_PLUGIN force-stop=$FLAG_FORCE_STOP"
}

main "$@"
