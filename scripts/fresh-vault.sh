#!/usr/bin/env bash
# fresh-vault.sh — wipe + rebuild a void-os vault for manual UX passes.
# Spec: docs/superpowers/specs/2026-05-18-vos-123-fresh-vault-bootstrap-design.md
set -euo pipefail

PATH_CANON=""
HOME_CANON=""

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

# --- path canonicalization ----------------------------------------------
# Resolve $HOME and <path> through the same routine. macOS $HOME is
# /Users/admin but resolves to /System/Volumes/Data/Users/admin under
# `pwd -P` — comparing canonicalized <path> against raw $HOME would
# always fail. Canonicalize both sides; compare those.
canon_home() {
  ( cd "$HOME" && pwd -P )
}

# Canonicalize <path>: resolve symlinks of the parent only, then re-join
# the final segment, because <path> itself may not exist yet.
canon_path() {
  local p="$1"
  local parent base
  # Expand leading ~ (parameter expansion isn't enough — bash's tilde
  # expansion only fires when unquoted in the source).
  case "$p" in
    "~")    p="$HOME" ;;
    "~/"*)  p="$HOME/${p#~/}" ;;
  esac
  parent="$(dirname "$p")"
  base="$(basename "$p")"
  if [ ! -d "$parent" ]; then
    echo "fresh-vault: parent dir does not exist: $parent" >&2
    exit 2
  fi
  parent="$( cd "$parent" && pwd -P )"
  if [ "$base" = "/" ] || [ "$base" = "." ] || [ "$base" = ".." ]; then
    echo "fresh-vault: refusing degenerate path: $p" >&2
    exit 2
  fi
  echo "$parent/$base"
}

# --- guard ---------------------------------------------------------------
# Refuse anything outside $HOME, or == $HOME, or == $HOME/vault.
guard_path() {
  local path_canon="$1"
  local home_canon="$2"
  if [ "$path_canon" = "$home_canon" ]; then
    echo "fresh-vault: refusing to wipe \$HOME itself ($path_canon)" >&2
    exit 2
  fi
  # Strict-inside check: $HOME must be a proper path-prefix.
  case "$path_canon" in
    "$home_canon"/*) ;;
    *)
      echo "fresh-vault: refusing path outside \$HOME ($path_canon vs $home_canon)" >&2
      exit 2 ;;
  esac
  if [ "$path_canon" = "$home_canon/vault" ]; then
    echo "fresh-vault: refusing literal ~/vault (real vault)" >&2
    exit 2
  fi
}

# --- confirm -------------------------------------------------------------
confirm_wipe() {
  if [ "$FLAG_YES" -eq 1 ]; then
    return 0
  fi
  printf "type 'yes' to wipe %s: " "$PATH_CANON"
  local reply
  read -r reply || reply=""
  if [ "$reply" != "yes" ]; then
    echo "aborted" >&2
    exit 0
  fi
}

# --- main ----------------------------------------------------------------
main() {
  parse_args "$@"
  local home_canon path_canon
  home_canon="$(canon_home)"
  path_canon="$(canon_path "$PATH_ARG")"
  guard_path "$path_canon" "$home_canon"
  PATH_CANON="$path_canon"
  HOME_CANON="$home_canon"
  echo "fresh-vault: guard ok — path=$PATH_CANON home=$HOME_CANON yes=$FLAG_YES skip-plugin=$FLAG_SKIP_PLUGIN force-stop=$FLAG_FORCE_STOP"
  confirm_wipe
}

main "$@"
