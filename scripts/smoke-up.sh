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

# Resolve /tmp → /private/tmp once up front (macOS symlink). The daemon's
# vault_root, Obsidian's basePath, and the bash pre-tool-use hook's path
# canonicalization must all agree on a single namespace, otherwise:
#   - daemon vault_root  = /tmp/...
#   - bash hook realpath = /private/tmp/...
# turns every `ls`/`cat` inside the vault into "outside read_scope".
# Compute on the parent SMOKE_ROOT, append /vault. Then OVERWRITE the
# lib-emitted SMOKE_VAULT/SMOKE_ROOT so every downstream reference (plugin
# layout, community-plugins.json, obsidian.json seed, Obsidian launch arg)
# lives in the same /private/tmp namespace.
mkdir -p "$SMOKE_ROOT"
SMOKE_ROOT="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$SMOKE_ROOT")"
SMOKE_VAULT="$SMOKE_ROOT/vault"
SMOKE_HOME="$SMOKE_ROOT/home"
SMOKE_USERDATA="$SMOKE_ROOT/obsidian-user-data"
SMOKE_PIDFILE="$SMOKE_ROOT/daemon.pid"
SMOKE_PORTFILE="$SMOKE_ROOT/daemon.port"
SMOKE_OBSIDIAN_PIDFILE="$SMOKE_ROOT/obsidian.pid"
SMOKE_LOG="$SMOKE_ROOT/daemon.log"

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

# Bridge Claude auth into the smoke HOME: claudev (the daemon's claude-code
# child) reads `~/.claudev/config` for the access code and `~/.claude` for
# Anthropic OAuth credentials. With HOME overridden to $SMOKE_HOME, the child
# can't find either. Symlink both from the operator's real home so chat runs
# can actually call the API. These dirs are mostly read; minor writes
# (cache, last-used-key) are acceptable spillover.
for d in .claude .claudev; do
  if [ -e "$HOME/$d" ] && [ ! -e "$SMOKE_HOME/$d" ]; then
    ln -sfn "$HOME/$d" "$SMOKE_HOME/$d"
  fi
done

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
  echo "smoke-up: rebuilding plugin so per-file-symlinked dist tracks HEAD"
  ( cd "$PLUGIN_DIR" && VOID_OS_PLUGIN_OUT="$PLUGIN_DIST" bun run build )
else
  echo "smoke-up: seeding fresh vault at $SMOKE_VAULT"
  ( cd "$PLUGIN_DIR" && VOID_OS_PLUGIN_OUT="$PLUGIN_DIST" bun run build )
  "$VOID_OS_BIN" init --non-interactive --vault "$SMOKE_VAULT" --skip-gh
fi

# Plugin layout: a REAL directory (not a symlink to plugin/dist) with each
# build artefact symlinked from PLUGIN_DIST. data.json lives here as a real
# file so smoke writes (daemonUrl, etc.) do NOT leak into the worktree's
# plugin/dist. Symlinks for main.js/manifest.json/styles.css preserve
# "edit plugin source → rebuild → next smoke-up sees it".
TARGET="$SMOKE_VAULT/.obsidian/plugins/void-os"
mkdir -p "$SMOKE_VAULT/.obsidian/plugins"
# If a prior smoke-up created TARGET as a symlink (legacy layout), drop it.
if [ -L "$TARGET" ]; then
  rm -f -- "$TARGET"
fi
mkdir -p "$TARGET"
# Symlink every build artefact in $PLUGIN_DIST/* (skip data.json — that one
# is owned by the smoke vault and must stay a real file so writes don't
# leak into the worktree's plugin/dist/). Re-run each smoke-up so any new
# artefact emitted by a later plugin build (e.g. sourcemaps, hot CSS) is
# picked up without touching this script.
shopt -s nullglob
for src in "$PLUGIN_DIST"/*; do
  base="$(basename "$src")"
  [ "$base" = "data.json" ] && continue
  rm -f -- "$TARGET/$base"
  ln -sfn "$src" "$TARGET/$base"
done
shopt -u nullglob

# Resolve port (sticky if portfile exists, else compute + probe-bump).
PORT="$(read_port_or_compute "$ID" "$SMOKE_ROOT")"

# Seed data.json with the smoke daemon's URL so the plugin targets THIS
# task's daemon (per-ID port) and not the operator's main daemon. The
# plugin's urlsFromAttachment resolution puts settings.daemonUrl ahead of
# the ensureDaemon-probed attachment.port (see plugin/src/daemon-urls.ts).
DATA_JSON="$TARGET/data.json"
DAEMON_URL_FOR_PLUGIN="http://127.0.0.1:$PORT"
python3 - "$DATA_JSON" "$DAEMON_URL_FOR_PLUGIN" <<'PY'
import json, sys, os
path, url = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f) or {}
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
data["daemonUrl"] = url
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
echo "smoke-up: seeded plugin data.json daemonUrl=$DAEMON_URL_FOR_PLUGIN"

# Enable void-os in community-plugins.json so Obsidian auto-loads it on
# vault open. Without this, the plugin sits dormant on disk and the user
# has to enable it manually (which the operator did during VOS-142 T5 but
# every cold smoke would need that step too). This mirrors the E2E
# fixture-vault pattern in plugin/e2e/globalSetup-autospawn.ts.
COMMUNITY_PLUGINS="$SMOKE_VAULT/.obsidian/community-plugins.json"
if [ ! -f "$COMMUNITY_PLUGINS" ]; then
  echo '["void-os"]' > "$COMMUNITY_PLUGINS"
  echo "smoke-up: enabled void-os in community-plugins.json"
fi

# Disable Obsidian's restricted (safe) mode so community plugins are
# actually loaded — restrictedMode defaults to true, which silently
# ignores community-plugins.json. Mirrors the e2e fixture app.json.
APP_JSON="$SMOKE_VAULT/.obsidian/app.json"
python3 - "$APP_JSON" <<'PY'
import json, sys, os
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f) or {}
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
data["restrictedMode"] = False
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
echo "smoke-up: set restrictedMode=false in app.json"

# Daemon spawn lives in Task 4.
[ "$FLAG_SKIP_DAEMON" -eq 1 ] && {
  echo "smoke-up: --skip-daemon → done (vault ready at $SMOKE_VAULT)"
  exit 0
}

# Daemon reuse: if recorded pid is alive AND its command line includes
# this worktree's daemon entrypoint, skip spawn. `$SMOKE_PIDFILE` holds
# the *real* bun daemon pid (written below after pidfile-poll), not the
# short-lived CLI wrapper. The real daemon's command line is
# `bun run <WORKTREE>/workspace/void-os/daemon/src/index.ts` — the
# absolute worktree path uniquely identifies this smoke instance.
DAEMON_ENTRYPOINT="$WORKTREE/workspace/void-os/daemon/src/index.ts"
SKIP_SPAWN=0
if [ -f "$SMOKE_PIDFILE" ]; then
  EX_PID="$(cat "$SMOKE_PIDFILE")"
  if pid_alive "$EX_PID"; then
    EX_CMD="$(ps -o command= -p "$EX_PID" 2>/dev/null || true)"
    case "$EX_CMD" in
      *"$DAEMON_ENTRYPOINT"*) SKIP_SPAWN=1 ;;
    esac
  fi
fi

if [ "$SKIP_SPAWN" -eq 1 ]; then
  echo "smoke-up: daemon already alive (pid=$(cat "$SMOKE_PIDFILE"), port=$PORT)"
else
  # Clear any stale daemon.json from a previous (now-dead) daemon so the
  # pidfile-poll below cannot short-circuit on yesterday's metadata. The
  # poll checks for the file's existence and a non-zero `pid` field, both
  # of which a stale file would satisfy even though the recorded pid no
  # longer maps to a live process.
  rm -f -- "$SMOKE_HOME/.void-os/daemon.json"
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

  # `void-os daemon start` is a short-lived wrapper that exits after
  # exec'ing the bun child. $! captured the wrapper; the real long-running
  # daemon pid lives in $SMOKE_HOME/.void-os/daemon.json. Overwrite
  # $SMOKE_PIDFILE so reuse-check and smoke-down target the real process.
  #
  # The daemon may write daemon.json in two steps (create empty, then
  # serialise JSON), so the file can exist but be momentarily empty or
  # contain partial JSON. Poll up to 5s for a valid JSON with a non-zero
  # `pid` field.
  REAL_PID=""
  i=0
  while [ "$i" -lt 50 ]; do
    REAL_PID="$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    p = d.get('pid')
    print(p if p else '')
except Exception:
    print('')
" "$SMOKE_HOME/.void-os/daemon.json" 2>/dev/null)"
    [ -n "$REAL_PID" ] && [ "$REAL_PID" != "0" ] && break
    sleep 0.1
    i=$((i+1))
  done
  if [ -z "$REAL_PID" ] || [ "$REAL_PID" = "0" ]; then
    echo "smoke-up: daemon.json never resolved a valid pid. Tail of $SMOKE_LOG:" >&2
    tail -30 "$SMOKE_LOG" >&2
    rm -f "$SMOKE_PIDFILE"
    exit 3
  fi
  echo "$REAL_PID" > "$SMOKE_PIDFILE"
fi

echo "smoke-up: daemon ready on http://127.0.0.1:$PORT"
echo "smoke-up: pidfile=$SMOKE_HOME/.void-os/daemon.json"
echo "smoke-up: smoke-pid=$(cat "$SMOKE_PIDFILE")"

# Obsidian spawn.
if [ "$FLAG_NO_OBSIDIAN" -eq 1 ]; then
  echo "smoke-up: --no-obsidian → skipping Obsidian"
  exit 0
fi

OBSIDIAN_BIN="/Applications/Obsidian.app/Contents/MacOS/Obsidian"
if [ ! -x "$OBSIDIAN_BIN" ]; then
  echo "smoke-up: WARNING — $OBSIDIAN_BIN not executable; skipping Obsidian spawn"
  echo "smoke-up: open manually: open 'obsidian://open?path=$SMOKE_VAULT'"
  exit 0
fi

# Pre-seed obsidian.json with the smoke vault registered + open + trusted.
# Shape mirrors what plugin/e2e/globalSetup.ts writes for its harness:
#   vaults: { <id>: { path, ts, open: true, trusted: true } }
#   updateDisabled: true   (don't auto-update Obsidian mid-session)
# `trusted: true` skips the "Trust author" modal on Obsidian 1.8+.
# `updateDisabled: true` prevents Obsidian from hot-swapping obsidian.asar
# and unloading the plugin underneath you.
VAULT_ID="$(printf '%s' "$SMOKE_VAULT" | cksum | awk '{print $1}')"
NOW_MS="$(date +%s)000"
cat > "$SMOKE_USERDATA/obsidian.json" <<EOF
{
  "vaults": {
    "$VAULT_ID": {
      "path": "$SMOKE_VAULT",
      "ts": $NOW_MS,
      "open": true,
      "trusted": true
    }
  },
  "updateDisabled": true
}
EOF

# Reuse-check for Obsidian process.
if [ -f "$SMOKE_OBSIDIAN_PIDFILE" ] && pid_alive "$(cat "$SMOKE_OBSIDIAN_PIDFILE")"; then
  echo "smoke-up: Obsidian already alive (pid=$(cat "$SMOKE_OBSIDIAN_PIDFILE"))"
else
  echo "smoke-up: spawning Obsidian with HOME=$SMOKE_HOME --user-data-dir=$SMOKE_USERDATA"
  # `open -na` is the macOS-correct way to launch a second instance of an
  # already-running .app bundle. Direct Mach-O exec
  # (`/Applications/Obsidian.app/Contents/MacOS/Obsidian`) yields a process
  # that exists but never gets a window/foreground registration when an
  # earlier instance is alive (LaunchServices routes it to background-only),
  # which silently keeps the plugin from running its renderer code. The `-n`
  # forces a new instance even if one is running; `-a` picks the .app
  # bundle by name; `--args` passes argv to the child.
  HOME="$SMOKE_HOME" open -na "Obsidian" --args \
    "--user-data-dir=$SMOKE_USERDATA" "$SMOKE_VAULT"
  # `open` returns immediately; resolve the spawned pid by finding the
  # newest /Applications/Obsidian.app/Contents/MacOS/Obsidian process with
  # our SMOKE_USERDATA in its command line.
  i=0
  OBS_PID=""
  while [ "$i" -lt 50 ]; do
    OBS_PID="$(pgrep -nf "Obsidian.*$SMOKE_USERDATA" 2>/dev/null || true)"
    [ -n "$OBS_PID" ] && break
    sleep 0.1
    i=$((i+1))
  done
  if [ -z "$OBS_PID" ]; then
    echo "smoke-up: failed to resolve smoke Obsidian pid within 5s" >&2
    exit 3
  fi
  echo "$OBS_PID" > "$SMOKE_OBSIDIAN_PIDFILE"
fi

echo "smoke-up: Obsidian pid=$(cat "$SMOKE_OBSIDIAN_PIDFILE")"
echo
echo "smoke-up: READY"
echo "  vault: $SMOKE_VAULT"
echo "  daemon: http://127.0.0.1:$PORT (pid $(cat "$SMOKE_PIDFILE"))"
echo "  obsidian: pid $(cat "$SMOKE_OBSIDIAN_PIDFILE")"
echo "  tear down: smoke-down.sh $ID"
exit 0
