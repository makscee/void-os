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

# Resolve port (sticky if portfile exists, else compute + probe-bump).
PORT="$(read_port_or_compute "$ID" "$SMOKE_ROOT")"

# Daemon reuse: if recorded pid is alive AND its command line includes
# 'void-os' AND 'daemon', skip spawn.
SKIP_SPAWN=0
if [ -f "$SMOKE_PIDFILE" ]; then
  EX_PID="$(cat "$SMOKE_PIDFILE")"
  if pid_alive "$EX_PID"; then
    EX_CMD="$(ps -o command= -p "$EX_PID" 2>/dev/null || true)"
    # Match on the smoke vault path specifically — not on a generic
    # 'void-os daemon' glob, which would also match the operator's
    # main daemon if pid recycling reuses our recorded pid.
    case "$EX_CMD" in
      *"--vault $SMOKE_VAULT"*) SKIP_SPAWN=1 ;;
    esac
  fi
fi

if [ "$SKIP_SPAWN" -eq 1 ]; then
  echo "smoke-up: daemon already alive (pid=$(cat "$SMOKE_PIDFILE"), port=$PORT)"
else
  echo "smoke-up: spawning daemon HOME=$SMOKE_HOME PORT=$PORT vault=$SMOKE_VAULT"
  # nohup + & detaches; redirect both streams to the smoke log.
  HOME="$SMOKE_HOME" VOID_OS_PORT="$PORT" \
    nohup "$VOID_OS_BIN" daemon start --vault "$SMOKE_VAULT" \
      >"$SMOKE_LOG" 2>&1 &
  echo $! > "$SMOKE_PIDFILE"

  # Poll for the pidfile the daemon itself writes (in isolated HOME).
  i=0
  while [ "$i" -lt 50 ] && [ ! -f "$SMOKE_HOME/.void-os/daemon.json" ]; do
    sleep 0.1
    i=$((i+1))
  done
  if [ ! -f "$SMOKE_HOME/.void-os/daemon.json" ]; then
    echo "smoke-up: daemon failed to write pidfile in 5s. Tail of $SMOKE_LOG:" >&2
    tail -30 "$SMOKE_LOG" >&2
    rm -f "$SMOKE_PIDFILE"
    exit 3
  fi
fi

echo "smoke-up: daemon ready on http://127.0.0.1:$PORT"
echo "smoke-up: pidfile=$SMOKE_HOME/.void-os/daemon.json"
echo "smoke-up: smoke-pid=$(cat "$SMOKE_PIDFILE")"

# Obsidian spawn lives in Task 5.
exit 0
