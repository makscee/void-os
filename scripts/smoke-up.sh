#!/usr/bin/env bash
# smoke-up.sh — stand up an isolated void-os stack for manual testing.
# Spec: docs/superpowers/specs/2026-05-18-vos-146-smoke-harness-design.md
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/smoke-paths.sh"

usage() {
  cat <<'EOF'
usage: smoke-up.sh <ID> [--reset] [--no-obsidian] [--skip-daemon]

  <ID>            task ID, e.g. VOS-146. Worktree at /Users/admin/hub-wt/<ID>
                  must exist (run /work <ID> first).
  --reset         wipe /tmp/void-os-smoke/<ID>/ and re-seed
  --no-obsidian   skip the Obsidian spawn
  --skip-daemon   skip the daemon spawn (used by tests; not for normal use)
  -h, --help      show this message
EOF
}

ID=""
FLAG_RESET=0
FLAG_NO_OBSIDIAN=0
FLAG_SKIP_DAEMON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --reset)       FLAG_RESET=1 ;;
    --no-obsidian) FLAG_NO_OBSIDIAN=1 ;;
    --skip-daemon) FLAG_SKIP_DAEMON=1 ;;
    -h|--help)     usage; exit 0 ;;
    --*)
      echo "smoke-up: unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$ID" ] || { echo "smoke-up: extra positional: $1" >&2; exit 2; }
      ID="$1" ;;
  esac
  shift
done
[ -n "$ID" ] || { echo "smoke-up: <ID> required" >&2; usage >&2; exit 2; }

WORKTREE="/Users/admin/hub-wt/$ID"
[ -d "$WORKTREE" ] || {
  echo "smoke-up: worktree $WORKTREE missing. Run /work $ID first." >&2
  exit 2
}

eval "$(resolve_paths "$ID")"

# Reset on demand (kill anything alive first).
if [ "$FLAG_RESET" -eq 1 ] && [ -d "$SMOKE_ROOT" ]; then
  echo "smoke-up: --reset → tearing down existing $SMOKE_ROOT"
  if [ -f "$SMOKE_PIDFILE" ]; then
    kill_grace "$(cat "$SMOKE_PIDFILE")" 2>/dev/null || true
  fi
  if [ -f "$SMOKE_OBSIDIAN_PIDFILE" ]; then
    kill_grace "$(cat "$SMOKE_OBSIDIAN_PIDFILE")" 2>/dev/null || true
  fi
  rm -rf -- "$SMOKE_ROOT"
fi

mkdir -p "$SMOKE_HOME" "$SMOKE_USERDATA"

# Vault provisioning.
PLUGIN_DIR="$WORKTREE/workspace/void-os/plugin"
PLUGIN_DIST="$PLUGIN_DIR/dist"
VOID_OS_BIN="$WORKTREE/workspace/void-os/bin/void-os"

if [ ! -x "$VOID_OS_BIN" ]; then
  echo "smoke-up: $VOID_OS_BIN missing or not executable" >&2
  exit 2
fi

if [ -d "$SMOKE_VAULT" ]; then
  echo "smoke-up: vault exists at $SMOKE_VAULT — reusing"
  echo "smoke-up: rebuilding plugin so symlinked dist tracks HEAD"
  ( cd "$PLUGIN_DIR" && VOID_OS_PLUGIN_OUT="$PLUGIN_DIST" bun run build )
else
  echo "smoke-up: seeding fresh vault at $SMOKE_VAULT"
  ( cd "$PLUGIN_DIR" && VOID_OS_PLUGIN_OUT="$PLUGIN_DIST" bun run build )
  "$VOID_OS_BIN" init --non-interactive --vault "$SMOKE_VAULT" --skip-gh
  TARGET="$SMOKE_VAULT/.obsidian/plugins/void-os"
  mkdir -p "$SMOKE_VAULT/.obsidian/plugins"
  rm -rf -- "$TARGET"
  ln -sfn "$PLUGIN_DIST" "$TARGET"
fi

# Daemon spawn lives in Task 4.
[ "$FLAG_SKIP_DAEMON" -eq 1 ] && {
  echo "smoke-up: --skip-daemon → done (vault ready at $SMOKE_VAULT)"
  exit 0
}

echo "smoke-up: TODO daemon spawn (Task 4)" >&2
exit 0

# Obsidian spawn lives in Task 5.
