#!/usr/bin/env bash
# fresh-vault.sh — wipe + rebuild a void-os vault for manual UX passes.
# Spec: docs/superpowers/specs/2026-05-18-vos-123-fresh-vault-bootstrap-design.md
set -euo pipefail

PATH_CANON=""
HOME_CANON=""

# Repo root = parent of scripts/ dir (this file's dir).
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd -P )"

# Prefer the repo's own bin/void-os so fresh clones work without a global
# install. Allow override via VOID_OS_BIN env var.
VOID_OS_BIN="${VOID_OS_BIN:-$REPO_ROOT/bin/void-os}"
if [ ! -x "$VOID_OS_BIN" ]; then
  echo "fresh-vault: void-os binary not executable at $VOID_OS_BIN" >&2
  echo "fresh-vault: set VOID_OS_BIN, or ensure $REPO_ROOT/bin/void-os is executable" >&2
  exit 2
fi

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

# --- plugin pre-build ----------------------------------------------------
# Run unconditionally before any destructive step so a build failure
# leaves the vault untouched. A stale dist/ from a prior aborted build
# would otherwise get symlinked and the "fresh vault" would silently
# run against old plugin code.
prebuild_plugin() {
  if [ "$FLAG_SKIP_PLUGIN" -eq 1 ]; then
    echo "fresh-vault: --skip-plugin → skipping plugin build"
    return 0
  fi
  if [ ! -d "$REPO_ROOT/plugin" ]; then
    echo "fresh-vault: plugin/ dir missing at $REPO_ROOT/plugin" >&2
    exit 2
  fi
  echo "fresh-vault: building plugin (bun run build) → $REPO_ROOT/plugin/dist"
  # build.ts defaults to ~/void/.obsidian/plugins/void-os; override so the
  # symlink in T8 can point at a repo-local artifact.
  ( cd "$REPO_ROOT/plugin" && VOID_OS_PLUGIN_OUT="$REPO_ROOT/plugin/dist" bun run build )
}

# --- daemon guard + stop ------------------------------------------------
# Probe void-os daemon status --json; if a daemon is serving a vault
# other than $PATH_CANON, refuse unless --force-stop. Treats CLI errors
# (subcommand missing, schema mismatch) as "no daemon" — destructive
# behaviour stays gated by --force-stop.
daemon_guard_and_stop() {
  local status_json running vault_root status_rc
  # Capture combined output and exit code. `daemon status` exits 0 for both
  # stopped and running-healthy; non-zero means a real error (corrupt
  # pid file, /health 500, schema mismatch). Don't silently treat that
  # as "no daemon" — a stale-state daemon would otherwise survive the
  # script and write into the freshly-inited vault.
  status_json="$("$VOID_OS_BIN" daemon status --json 2>&1)" && status_rc=0 || status_rc=$?
  if [ "$status_rc" -ne 0 ]; then
    if [ "$FLAG_FORCE_STOP" -eq 1 ]; then
      echo "fresh-vault: WARNING — daemon status failed (rc=$status_rc); --force-stop set, proceeding" >&2
      echo "$status_json" >&2
      "$VOID_OS_BIN" daemon stop 2>/dev/null || true
      return 0
    fi
    echo "fresh-vault: daemon status failed (rc=$status_rc) — pass --force-stop to override" >&2
    echo "$status_json" >&2
    exit 2
  fi
  running="$(printf '%s' "$status_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print("1" if d.get("running") else "0")
except Exception:
    print("0")
')"
  if [ "$running" != "1" ]; then
    echo "fresh-vault: daemon not running"
    return 0
  fi
  vault_root="$(printf '%s' "$status_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("vault_root") or "")
except Exception:
    print("")
')"
  # Canonicalize daemon's vault_root the same way for comparison.
  local daemon_vault_canon=""
  if [ -n "$vault_root" ] && [ -d "$vault_root" ]; then
    daemon_vault_canon="$( cd "$vault_root" && pwd -P )"
  fi
  if [ "$daemon_vault_canon" = "$PATH_CANON" ]; then
    echo "fresh-vault: stopping daemon (serving target vault)"
    "$VOID_OS_BIN" daemon stop
    return 0
  fi
  if [ "$FLAG_FORCE_STOP" -eq 1 ]; then
    echo "fresh-vault: WARNING — stopping daemon serving foreign vault: $vault_root"
    "$VOID_OS_BIN" daemon stop
    return 0
  fi
  echo "fresh-vault: refusing to stop daemon serving foreign vault: $vault_root" >&2
  echo "fresh-vault: pass --force-stop to override" >&2
  exit 2
}

# --- wipe ----------------------------------------------------------------
wipe_path() {
  if [ -e "$PATH_CANON" ] || [ -L "$PATH_CANON" ]; then
    echo "fresh-vault: wiping $PATH_CANON"
    rm -rf -- "$PATH_CANON"
  else
    echo "fresh-vault: $PATH_CANON does not exist — nothing to wipe"
  fi
}

# --- init ---------------------------------------------------------------
run_init() {
  echo "fresh-vault: running void-os init --non-interactive --vault $PATH_CANON --skip-gh"
  "$VOID_OS_BIN" init --non-interactive --vault "$PATH_CANON" --skip-gh
}

# --- plugin symlink -----------------------------------------------------
link_plugin() {
  if [ "$FLAG_SKIP_PLUGIN" -eq 1 ]; then
    echo "fresh-vault: --skip-plugin → skipping plugin symlink"
    return 0
  fi
  local dist="$REPO_ROOT/plugin/dist"
  local target="$PATH_CANON/.obsidian/plugins/void-os"
  if [ ! -d "$dist" ]; then
    echo "fresh-vault: plugin/dist missing — pre-build failed silently?" >&2
    exit 1
  fi
  mkdir -p "$PATH_CANON/.obsidian/plugins"
  # `void-os init` already copies the plugin into .obsidian/plugins/void-os/
  # as a dir; without removing it, `ln -sfn` would create $target/dist (a
  # symlink *inside* the dir) instead of replacing it. Force-replace.
  rm -rf -- "$target"
  ln -sfn "$dist" "$target"
  echo "fresh-vault: symlinked plugin: $target → $dist"
}

# --- daemon start + hint ------------------------------------------------
start_daemon() {
  echo "fresh-vault: starting daemon on $PATH_CANON"
  "$VOID_OS_BIN" daemon start --vault "$PATH_CANON"
}

print_next_steps() {
  if [ "$FLAG_SKIP_PLUGIN" -eq 1 ]; then
    echo "next: daemon up on $PATH_CANON; plugin link skipped (--skip-plugin)"
  else
    echo "next: open Obsidian on $PATH_CANON, enable void-os plugin"
  fi
}

# --- main ----------------------------------------------------------------
main() {
  parse_args "$@"
  command -v python3 >/dev/null 2>&1 || {
    echo "fresh-vault: python3 required for daemon status parsing — install python3 or run inside a shell where 'python3' is on PATH" >&2
    exit 2
  }
  local home_canon path_canon
  home_canon="$(canon_home)"
  path_canon="$(canon_path "$PATH_ARG")"
  guard_path "$path_canon" "$home_canon"
  PATH_CANON="$path_canon"
  HOME_CANON="$home_canon"
  confirm_wipe
  prebuild_plugin
  daemon_guard_and_stop
  wipe_path
  run_init
  link_plugin
  start_daemon
  print_next_steps
}

main "$@"
