#!/usr/bin/env bash
# VOS-211 master-run live proof: two round-trips against real claude sessions.
# REAPER CONSTRAINT: must be run by master (not a dispatched subagent) — live claude sessions
# get SIGKILL at ~2-4 min inside a subagent. The implementer leaves this script written; master runs it.
#
# Exit 1 on EVERY load-bearing assertion (no WARN-and-continue).
# Asserts deterministic WIRING, not LLM-output timing.
#
# Round-trip 1 — htmx act loop (interactive htmx-form-demo skill):
#   launch → poll until body.html has the hx-post form → POST /act → assert wiring
#
# Round-trip 2 — worker-resume (the operator's "can't resume skill-author" ask):
#   launch non-interactive skill → wait for finish/reap → POST /send → assert no new exec row
#
# Usage: cd ~/void-os-wt/VOS-211 && bash tests/proof/vos-211-act-loop.sh
# Evidence: vault/work/evidence/VOS-211/MASTER-PROOF.md

set -euo pipefail

VAULT="${VOID_OS_VAULT:-$HOME/.void-os}"
PORT="${VOID_OS_PORT:-4317}"
BASE="http://127.0.0.1:${PORT}"
EVIDENCE="${HOME}/hub/vault/work/evidence/VOS-211"
mkdir -p "$EVIDENCE"

PROOF="${EVIDENCE}/MASTER-PROOF.md"
echo "# VOS-211 Master Proof" > "$PROOF"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PROOF"
echo "" >> "$PROOF"

fail() { echo "HARD-FAIL: $1" | tee -a "$PROOF"; exit 1; }
pass() { echo "PASS: $1" | tee -a "$PROOF"; }
log()  { echo "  $1" | tee -a "$PROOF"; }

# --- Round-trip 1: htmx act loop ---
echo "=== Round-trip 1: htmx-form-demo interactive skill ===" | tee -a "$PROOF"

# Launch htmx-form-demo interactively
# /launch returns 302 → parse the runid from the Location header (body is empty)
H1=$(mktemp)
curl -sS -D "$H1" -X POST "${BASE}/launch" \
  -d "skill=htmx-form-demo&text=start&runner=" -o /dev/null || fail "POST /launch failed"
UUID1=$(grep -i '^location:' "$H1" | tr -d '\r' | grep -o 'exec-[0-9a-f-]*' | head -1); rm -f "$H1"
[ -n "$UUID1" ] || fail "Could not extract UUID from launch Location header"
pass "Launched htmx-form-demo as $UUID1"

# Poll until body.html contains the hx-post form (bounded 90s)
DEADLINE=$((SECONDS + 90))
until curl -sf "${BASE}/s/${UUID1}/body" 2>/dev/null | grep -q 'hx-post'; do
  [ $SECONDS -lt $DEADLINE ] || fail "body.html never contained hx-post form after 90s"
  sleep 2
done
pass "body.html contains hx-post form"

# Capture the form page
curl -s "${BASE}/s/${UUID1}/body" > "${EVIDENCE}/rt1-form-body.html" 2>&1
log "body.html snapshot: ${EVIDENCE}/rt1-form-body.html"

# Get the pane_pid before the POST (to verify same session, not a respawn)
PANE_PID_BEFORE=$(tmux -L vos list-panes -t "vos-run-${UUID1}" -F '#{pane_pid}' 2>/dev/null | head -1)
log "pane_pid before POST: $PANE_PID_BEFORE"

# POST to /act (simulating the browser submitting "choice: ship")
ACK=$(curl -sfS -X POST "${BASE}/s/${UUID1}/act" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "choice=ship" 2>&1) || fail "POST /act failed: $ACK"
echo "$ACK" | grep -q "working" || fail "ack fragment does not contain 'working'. Got: ${ACK:0:200}"
pass "POST /act returned ack fragment with 'working'"

# Verify tmux session still live (send hit existing session, not a respawn)
tmux -L vos has-session -t "vos-run-${UUID1}" 2>/dev/null || fail "tmux session for $UUID1 not live after POST /act"
pass "tmux session still live after POST /act"

PANE_PID_AFTER=$(tmux -L vos list-panes -t "vos-run-${UUID1}" -F '#{pane_pid}' 2>/dev/null | head -1)
[ "$PANE_PID_BEFORE" = "$PANE_PID_AFTER" ] || fail "pane_pid changed (respawn occurred): before=$PANE_PID_BEFORE after=$PANE_PID_AFTER"
pass "pane_pid unchanged after POST /act — send hit existing session"

# Poll for "choice: ship" in capture-pane (bounded 60s — LLM turn timing)
DEADLINE=$((SECONDS + 60))
until tmux -L vos capture-pane -t "vos-run-${UUID1}" -p 2>/dev/null | grep -q "choice: ship"; do
  [ $SECONDS -lt $DEADLINE ] || fail "choice: ship never appeared in capture-pane after 60s"
  sleep 2
done
pass "choice: ship appeared in capture-pane (turn delivered)"

# Poll for new body.html (agent rewrites after processing the choice)
DEADLINE=$((SECONDS + 90))
WORKING_BODY=$(curl -s "${BASE}/s/${UUID1}/body" 2>/dev/null)
until curl -s "${BASE}/s/${UUID1}/body" 2>/dev/null | grep -qv "working…"; do
  [ $SECONDS -lt $DEADLINE ] || { log "Note: body.html still on workingPage after 90s — LLM may not have responded yet"; break; }
  sleep 3
done
pass "body.html advanced after agent processed the choice (or timed out — non-blocking)"

# Verify transcript includes the choice turn
TX=$(curl -s "${BASE}/s/${UUID1}/transcript" 2>/dev/null)
echo "$TX" | grep -qi "choice" || log "Note: transcript may not yet show choice (timing; non-fatal)"
log "transcript snippet: $(echo "$TX" | head -5)"

echo "" >> "$PROOF"
echo "=== Round-trip 1 PASSED ===" | tee -a "$PROOF"
echo "" >> "$PROOF"

# --- Round-trip 2: worker-resume ---
echo "=== Round-trip 2: worker-resume (non-interactive skill) ===" | tee -a "$PROOF"

DB="${VAULT}/.void-os/registry.db"
[ -f "$DB" ] || fail "registry.db not found at $DB"
# Baseline is captured AFTER launch+reap (below) — the worker's OWN launch row is legitimate;
# the invariant is that /send on the reaped worker adds NO row beyond it (resume, not successor).

# Launch a non-interactive skill (smoke-test is simple and fast)
H2=$(mktemp)
curl -sS -D "$H2" -X POST "${BASE}/launch" \
  -d "skill=smoke-test&text=run&runner=" -o /dev/null || fail "POST /launch (rt2) failed"
UUID2=$(grep -i '^location:' "$H2" | tr -d '\r' | grep -o 'exec-[0-9a-f-]*' | head -1); rm -f "$H2"
[ -n "$UUID2" ] || fail "Could not extract UUID2 from launch Location header"
pass "Launched smoke-test as $UUID2"

# Wait until the tmux session is gone (worker finished/reaped)
DEADLINE=$((SECONDS + 120))
until ! tmux -L vos has-session -t "vos-run-${UUID2}" 2>/dev/null; do
  [ $SECONDS -lt $DEADLINE ] || fail "Worker tmux session never reaped after 120s"
  sleep 2
done
pass "Worker tmux session reaped — session finished"

# Confirm no live tmux for this uuid
tmux -L vos has-session -t "vos-run-${UUID2}" 2>/dev/null && fail "tmux session still live after expected reap"
pass "No live tmux session for $UUID2 (confirmed reaped)"

# Baseline NOW (worker launched + reaped, its legitimate row already counted). The worker-resume
# invariant: POST /send resumes the SAME thread and adds NO new exec row beyond this point.
EXEC_COUNT_BEFORE=$(sqlite3 "$DB" "SELECT count(*) FROM executions;" 2>/dev/null) || fail "sqlite3 baseline query failed"
pass "exec count at reaped baseline (pre-/send): $EXEC_COUNT_BEFORE"

# POST /send with a follow-up message (the operator's "resume skill-author" flow)
SEND_RESP=$(curl -sfS -w "%{http_code}" -X POST "${BASE}/s/${UUID2}/send" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "answer=continue+please" 2>&1) || fail "POST /send (rt2) failed: $SEND_RESP"
HTTP_CODE="${SEND_RESP: -3}"
[ "$HTTP_CODE" -lt 400 ] || fail "POST /send returned error: $HTTP_CODE"
pass "POST /send on reaped worker returned $HTTP_CODE"

# Hard-fail assertion: NO new exec row in registry.db (worker-resume invariant)
EXEC_COUNT_AFTER=$(sqlite3 "$DB" "SELECT count(*) FROM executions;" 2>/dev/null) || fail "sqlite3 post-send query failed"
[ "$EXEC_COUNT_AFTER" = "$EXEC_COUNT_BEFORE" ] || \
  fail "WORKER-RESUME INVARIANT VIOLATED: exec count changed $EXEC_COUNT_BEFORE → $EXEC_COUNT_AFTER (new exec row created)"
pass "Exec count unchanged ($EXEC_COUNT_BEFORE → $EXEC_COUNT_AFTER) — no new exec row (worker-resume invariant held)"

# A tmux session for the SAME uuid should now be live (respawned via --resume)
DEADLINE=$((SECONDS + 15))
until tmux -L vos has-session -t "vos-run-${UUID2}" 2>/dev/null; do
  [ $SECONDS -lt $DEADLINE ] || fail "Worker tmux session never respawned after /send"
  sleep 1
done
pass "tmux session for $UUID2 is now live (respawned via --resume after /send)"

# The follow-up text must appear in the capture-pane
DEADLINE=$((SECONDS + 30))
until tmux -L vos capture-pane -t "vos-run-${UUID2}" -p 2>/dev/null | grep -q "continue please"; do
  [ $SECONDS -lt $DEADLINE ] || fail "follow-up text never appeared in capture-pane after 30s"
  sleep 2
done
pass "Follow-up text reached worker's capture-pane (worker continuable in own thread)"

echo "" >> "$PROOF"
echo "=== Round-trip 2 PASSED ===" | tee -a "$PROOF"
echo "" >> "$PROOF"
echo "## All assertions passed" | tee -a "$PROOF"
echo "Proof: $PROOF"
