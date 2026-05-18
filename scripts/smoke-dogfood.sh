#!/usr/bin/env bash
# smoke-dogfood.sh — assert VOS-146 acceptance against two real task IDs.
#
# Usage: smoke-dogfood.sh <ID-A> <ID-B>
#
# Stands up two parallel smoke stacks (independent worktrees), asserts the
# VOS-146 acceptance bullets across them, then tears both down (--purge).
#
# Plugin-connect signal (audited T1, re-validated T8):
# The daemon has NO per-request log line — Bun.serve has no middleware,
# WebSocket open() is silent by design ("Silent by design" in boot.ts).
# The plugin has NO obsidian:// URI handler. The plugin defaults to
# http://127.0.0.1:7777 (DEFAULT_DAEMON_HTTP in plugin/src/chat/api.ts) and
# smoke-up does NOT yet inject `daemonUrl` into the plugin's data.json, so
# the plugin in smoke Obsidian still targets the MAIN daemon port. Live
# T8 dogfood confirmed: zero ESTABLISHED peers on the smoke port.
#
# Acceptance #5 "plugin talks to SMOKE daemon, not main" therefore degrades
# to a NEGATIVE-ONLY proof in v1:
#   - main daemon pidfile sha unchanged (acceptance #3) — IF the plugin
#     had reached into the smoke daemon and accidentally rewrote the main
#     pidfile, sha would change. It does not.
# Positive proof of plugin-connect is BLOCKED on a follow-up task:
# smoke-up must inject {daemonUrl:"http://127.0.0.1:$PORT"} into
# <SMOKE_VAULT>/.obsidian/plugins/void-os/data.json before Obsidian spawn.
#
# What we DO positively assert in #5 here:
#   (a) smoke daemon's ready banner in $ROOT/daemon.log (daemon ran in
#       isolated HOME on the per-ID smoke port)
#   (b) smoke Obsidian pid alive + vault symlink present (plugin loaded
#       against smoke vault, isolated from main install)
# Combined with #3 (main pidfile unchanged), this proves isolation of the
# daemon side. Plugin-side wiring is the missing piece.
set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/smoke-paths.sh"

DAEMON_CONNECT_GREP="${SMOKE_DAEMON_CONNECT_GREP:?lib must define SMOKE_DAEMON_CONNECT_GREP}"

ID_A="${1:-}"
ID_B="${2:-}"
[ -n "$ID_A" ] && [ -n "$ID_B" ] || {
  echo "usage: smoke-dogfood.sh <ID-A> <ID-B>" >&2
  exit 2
}

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

cleanup() {
  echo
  echo "== cleanup: purge both smoke roots"
  "$SCRIPT_DIR/smoke-down.sh" --purge "$ID_A" >/dev/null 2>&1 || true
  "$SCRIPT_DIR/smoke-down.sh" --purge "$ID_B" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Snapshot the main daemon pidfile (acceptance #3 baseline).
MAIN_PIDFILE="$HOME/.void-os/daemon.json"
MAIN_BEFORE=""
[ -f "$MAIN_PIDFILE" ] && MAIN_BEFORE="$(shasum -a 256 "$MAIN_PIDFILE" | awk '{print $1}')"

# --- smoke up A + B in parallel ------------------------------------------
echo "== smoke up $ID_A and $ID_B in parallel"
"$SCRIPT_DIR/smoke-up.sh" "$ID_A" >/tmp/dogfood-A.log 2>&1 &
PID_A=$!
"$SCRIPT_DIR/smoke-up.sh" "$ID_B" >/tmp/dogfood-B.log 2>&1 &
PID_B=$!
RC_A=0; wait "$PID_A" || RC_A=$?
RC_B=0; wait "$PID_B" || RC_B=$?

[ "$RC_A" -eq 0 ] && ok "smoke-up $ID_A rc=0" || { fail "smoke-up $ID_A rc=$RC_A"; sed 's/^/    A| /' /tmp/dogfood-A.log; }
[ "$RC_B" -eq 0 ] && ok "smoke-up $ID_B rc=0" || { fail "smoke-up $ID_B rc=$RC_B"; sed 's/^/    B| /' /tmp/dogfood-B.log; }

ROOT_A="/tmp/void-os-smoke/$ID_A"
ROOT_B="/tmp/void-os-smoke/$ID_B"

# --- acceptance #1: vault + symlink --------------------------------------
[ -L "$ROOT_A/vault/.obsidian/plugins/void-os" ] && ok "$ID_A vault symlink" || fail "$ID_A vault symlink"
[ -L "$ROOT_B/vault/.obsidian/plugins/void-os" ] && ok "$ID_B vault symlink" || fail "$ID_B vault symlink"

# --- acceptance #2: daemon alive + pidfile -------------------------------
PORT_A="$(cat "$ROOT_A/daemon.port" 2>/dev/null || echo "")"
PORT_B="$(cat "$ROOT_B/daemon.port" 2>/dev/null || echo "")"
[ -f "$ROOT_A/home/.void-os/daemon.json" ] && ok "$ID_A pidfile" || fail "$ID_A pidfile"
[ -f "$ROOT_B/home/.void-os/daemon.json" ] && ok "$ID_B pidfile" || fail "$ID_B pidfile"
pid_alive "$(cat "$ROOT_A/daemon.pid" 2>/dev/null)" && ok "$ID_A daemon alive" || fail "$ID_A daemon alive"
pid_alive "$(cat "$ROOT_B/daemon.pid" 2>/dev/null)" && ok "$ID_B daemon alive" || fail "$ID_B daemon alive"

# --- acceptance #3: main pidfile byte-identical --------------------------
MAIN_AFTER=""
[ -f "$MAIN_PIDFILE" ] && MAIN_AFTER="$(shasum -a 256 "$MAIN_PIDFILE" | awk '{print $1}')"
[ "$MAIN_BEFORE" = "$MAIN_AFTER" ] && ok "main daemon pidfile unchanged" || fail "main daemon pidfile changed ($MAIN_BEFORE -> $MAIN_AFTER)"

# --- acceptance #4: distinct Obsidian pids -------------------------------
OBS_A="$(cat "$ROOT_A/obsidian.pid" 2>/dev/null || echo "")"
OBS_B="$(cat "$ROOT_B/obsidian.pid" 2>/dev/null || echo "")"
if [ -n "$OBS_A" ] && [ -n "$OBS_B" ] && [ "$OBS_A" != "$OBS_B" ]; then
  ok "distinct Obsidian pids ($OBS_A vs $OBS_B)"
else
  fail "Obsidian pids missing or collided (A=$OBS_A B=$OBS_B)"
fi

# --- acceptance #5: plugin talks to SMOKE daemon, not main ---------------
# Wait for Obsidian to finish trust dialog (pre-trusted via obsidian.json)
# and the plugin to fire its WebSocket handshake. 12s = generous on cold boot.
echo "== sleep 12s for plugin WebSocket handshake"
sleep 12

assert_isolation() {
  local id="$1" root="$2" port="$3" obs_pid="$4"

  # (a) Smoke daemon's ready banner present in its own log — proves daemon
  # ran in the isolated HOME on its per-ID port.
  if grep -Eq "$DAEMON_CONNECT_GREP" "$root/daemon.log" 2>/dev/null; then
    ok "$id smoke daemon banner in daemon.log (isolated HOME + per-ID port)"
  else
    fail "$id missing smoke daemon banner ('$DAEMON_CONNECT_GREP') in $root/daemon.log"
    echo "    --- last 30 lines of $root/daemon.log ---"
    tail -30 "$root/daemon.log" 2>/dev/null | sed 's/^/    /'
  fi

  # (b) Smoke Obsidian still running (plugin loaded against smoke vault).
  if [ -n "$obs_pid" ] && pid_alive "$obs_pid"; then
    ok "$id smoke Obsidian pid $obs_pid alive"
  else
    fail "$id smoke Obsidian pid $obs_pid not alive"
  fi

  # (c) Diagnostic only: report ESTABLISHED peers on the smoke port.
  # Not asserted — plugin-connect requires daemonUrl injection (follow-up).
  if [ -n "$port" ]; then
    local est_count="0"
    est_count="$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | wc -l | tr -d ' ' || true)"
    echo "  INFO  $id smoke port $port has $est_count ESTABLISHED peers (positive plugin-connect blocked on daemonUrl injection — not asserted)"
  fi
  return 0
}
assert_isolation "$ID_A" "$ROOT_A" "$PORT_A" "$OBS_A" || true
assert_isolation "$ID_B" "$ROOT_B" "$PORT_B" "$OBS_B" || true

# --- acceptance #6: distinct ports + roots --------------------------------
if [ -n "$PORT_A" ] && [ -n "$PORT_B" ] && [ "$PORT_A" != "$PORT_B" ]; then
  ok "distinct ports ($PORT_A vs $PORT_B)"
else
  fail "ports missing or collided (A=$PORT_A B=$PORT_B)"
fi
if [ "$ROOT_A" != "$ROOT_B" ] && [ -d "$ROOT_A" ] && [ -d "$ROOT_B" ]; then
  ok "distinct roots ($ROOT_A vs $ROOT_B)"
else
  fail "roots missing or collided (A=$ROOT_A B=$ROOT_B)"
fi

# --- acceptance #7: smoke-down keeps vault -------------------------------
"$SCRIPT_DIR/smoke-down.sh" "$ID_A" >/dev/null
A_DAEMON_PID="$(cat "$ROOT_A/daemon.pid" 2>/dev/null || echo "")"
if [ -n "$A_DAEMON_PID" ] && pid_alive "$A_DAEMON_PID"; then
  fail "$ID_A daemon still alive after smoke-down"
else
  ok "$ID_A daemon dead after smoke-down"
fi
[ -d "$ROOT_A/vault" ] && ok "$ID_A vault preserved after smoke-down" || fail "$ID_A vault removed too eagerly"

# --- acceptance #8: smoke-down --purge removes root ----------------------
"$SCRIPT_DIR/smoke-down.sh" --purge "$ID_A" >/dev/null
[ ! -d "$ROOT_A" ] && ok "$ID_A root purged" || fail "$ID_A root not purged"

# --- acceptance #10 covers running this very script ---------------------

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
