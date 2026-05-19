#!/usr/bin/env bash
# smoke-down.sh — tear down the per-ID void-os stack.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/smoke-paths.sh"

usage() {
  cat <<'EOF'
usage: smoke-down.sh <ID> [--purge]

  <ID>      task ID, e.g. VOS-146
  --purge   also remove /tmp/void-os-smoke/<ID>/ (default: keep vault)
  -h, --help  show this message
EOF
}

ID=""
FLAG_PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)   FLAG_PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "smoke-down: unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$ID" ] || { echo "smoke-down: extra positional: $1" >&2; exit 2; }
      ID="$1" ;;
  esac
  shift
done
[ -n "$ID" ] || { echo "smoke-down: <ID> required" >&2; usage >&2; exit 2; }

eval "$(resolve_paths "$ID")"

if [ ! -d "$SMOKE_ROOT" ]; then
  echo "smoke-down: $SMOKE_ROOT does not exist — nothing to do"
  exit 0
fi

if [ -f "$SMOKE_OBSIDIAN_PIDFILE" ]; then
  obs_pid="$(cat "$SMOKE_OBSIDIAN_PIDFILE" 2>/dev/null || echo "")"
  if [ -n "$obs_pid" ]; then
    echo "smoke-down: killing Obsidian pid=$obs_pid"
    kill_grace "$obs_pid"
  fi
  rm -f "$SMOKE_OBSIDIAN_PIDFILE"
fi

if [ -f "$SMOKE_PIDFILE" ]; then
  d_pid="$(cat "$SMOKE_PIDFILE" 2>/dev/null || echo "")"
  if [ -n "$d_pid" ]; then
    echo "smoke-down: killing daemon pid=$d_pid"
    kill_grace "$d_pid"
  fi
  rm -f "$SMOKE_PIDFILE"
fi

if [ "$FLAG_PURGE" -eq 1 ]; then
  echo "smoke-down: --purge → rm -rf $SMOKE_ROOT"
  rm -rf -- "$SMOKE_ROOT"
fi

echo "smoke-down: done ($ID)"
exit 0
