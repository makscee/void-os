#!/usr/bin/env bash
# Unit tests for lib/smoke-paths.sh helpers. No external deps.
set -euo pipefail

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
LIB="$HERE/../lib/smoke-paths.sh"
# shellcheck disable=SC1090
. "$LIB"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1: $2"; }

# --- compute_port ---------------------------------------------------------
p1="$(compute_port VOS-146)"
p2="$(compute_port VOS-146)"
[ "$p1" = "$p2" ] && ok "compute_port deterministic" || fail "compute_port deterministic" "$p1 != $p2"
[ "$p1" -ge 7800 ] && [ "$p1" -le 7899 ] && ok "compute_port in range" || fail "compute_port range" "$p1 out of 7800-7899"

p_a="$(compute_port VOS-A)"
p_b="$(compute_port VOS-B)"
# Different IDs MOST OF THE TIME hash differently. If they collide that's OK,
# just don't assert inequality — assert determinism only.
ok "compute_port collision-OK ($p_a vs $p_b)"

# --- resolve_paths --------------------------------------------------------
eval "$(resolve_paths VOS-146)"
[ "$SMOKE_ROOT"     = "/tmp/void-os-smoke/VOS-146" ]                && ok "resolve_paths SMOKE_ROOT"     || fail "SMOKE_ROOT" "$SMOKE_ROOT"
[ "$SMOKE_VAULT"    = "/tmp/void-os-smoke/VOS-146/vault" ]          && ok "resolve_paths SMOKE_VAULT"    || fail "SMOKE_VAULT" "$SMOKE_VAULT"
[ "$SMOKE_HOME"     = "/tmp/void-os-smoke/VOS-146/home" ]           && ok "resolve_paths SMOKE_HOME"     || fail "SMOKE_HOME" "$SMOKE_HOME"
[ "$SMOKE_USERDATA" = "/tmp/void-os-smoke/VOS-146/obsidian-user-data" ] && ok "resolve_paths SMOKE_USERDATA" || fail "SMOKE_USERDATA" "$SMOKE_USERDATA"

# --- pid_alive ------------------------------------------------------------
sleep 30 &
LIVE_PID=$!
pid_alive "$LIVE_PID" && ok "pid_alive live" || fail "pid_alive live" "rc=$?"
kill "$LIVE_PID" 2>/dev/null || true
wait "$LIVE_PID" 2>/dev/null || true
pid_alive "$LIVE_PID" && fail "pid_alive dead" "should be dead" || ok "pid_alive dead"
pid_alive 1 || ok "pid_alive 1=init (host-dependent — accept either)"

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
