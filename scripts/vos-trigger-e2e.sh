#!/usr/bin/env bash
# vos-trigger-e2e.sh — VOS-189 real-path proof for all Trigger scenarios.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-trigger-e2e.sh
#
# Scenarios:
#   1. Manual Trigger → real Run → real CC hooks → running/exited_ok
#   2. Schedule Trigger → daemon tick fires at cron time → Run created
#   3. Event inbox → vos-inbox-append.sh → drain → Run created
#   4. Runaway ceiling → PreToolUse counted → breach → exited_fail + tmux gone
#   5. Interactive Run exempt (trigger_id=NULL, step_ceiling=NULL)
#   6. Unit test regression
#
# Note: trigger-fired Runs use -p (print mode) so CC skips the workspace trust dialog
# in automated contexts. Print mode fires all hooks (SessionStart, PreToolUse, SessionEnd).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos189-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14319
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos189-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  # Clean proof artifacts but keep the vault (fixed trusted path)
  rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"
  # No looper skill to clean up
}
trap cleanup EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

query_db() {
  bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const rows = db.query(\"$1\").all();
    console.log(JSON.stringify(rows, null, 2));
  " 2>/dev/null
}

wait_run_state() {
  local run_id="$1" expected="$2" deadline=$((SECONDS + $3))
  while [[ $SECONDS -lt $deadline ]]; do
    local state
    state=$(bun --eval "
      const { Database } = require('bun:sqlite');
      const db = new Database('$DB');
      const r = db.query('SELECT state FROM runs WHERE id=?').get('$run_id');
      console.log(r ? r.state : 'none');
    " 2>/dev/null) || state="error"
    [[ "$state" == "$expected" ]] && return 0
    sleep 1
  done
  local actual
  actual=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query('SELECT state,reason FROM runs WHERE id=?').get('$run_id');
    console.log(JSON.stringify(r));
  " 2>/dev/null)
  fail "run $run_id: expected $expected, got: $actual"
}

fire_trigger() {
  local name="$1"
  local resp
  resp=$(bun --eval "
    const r = await fetch('$DAEMON_URL/triggers/$name/fire', { method: 'POST' });
    const j = await r.json();
    console.log(JSON.stringify(j));
  " 2>/dev/null)
  echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('runId','null'))" 2>/dev/null
}

# ---- Setup ----

rm -f "$LOG"
log "=== VOS-189 real-path proof ==="
log "Vault: $VAULT  Port: $PORT"

# Clean up prior run artifacts
rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"
mkdir -p "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"

# No looper skill needed — ceiling test uses a direct prompt

cat > "$VAULT/void-os.json" << CONF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": ["smoke-test"],
  "answers": {},
  "port": $PORT,
  "runners": [{"label": "vc (relay)", "command": "vc --"}],
  "defaultRunner": "vc (relay)"
}
CONF

# Write triggers BEFORE daemon starts (boot reconcile loads them)
cat > "$VAULT/triggers/manual-smoke.md" << 'EOF'
---
kind: manual
skill: smoke-test
agent: default
step_ceiling: 30
---
EOF

# ceiling-test: step_ceiling: 1 so the FIRST tool call triggers the breach.
# skill "run ..." becomes "-p /run ..." which CC executes via Bash tool.
cat > "$VAULT/triggers/ceiling-test.md" << 'EOF'
---
kind: manual
skill: run these bash commands separately via tool calls: echo vos189-step1, echo vos189-step2, echo vos189-step3
agent: default
step_ceiling: 1
---
EOF

# ---- Start daemon ----
log "Starting daemon on port $PORT..."
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --port $PORT --no-open > /tmp/vos189-daemon.log 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 20); do
  if bun --eval "const r = await fetch('$DAEMON_URL/').catch(()=>null); process.exit(r ? 0 : 1);" 2>/dev/null; then
    log "Daemon ready (pid $DAEMON_PID)"
    break
  fi
  sleep 1
  [[ $i -eq 20 ]] && fail "Daemon did not start within 20s"
done

# Verify boot reconcile loaded triggers
for i in $(seq 1 5); do
  TCOUNT=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    console.log(db.query('SELECT count(*) as n FROM triggers').get().n);
  " 2>/dev/null) || TCOUNT=0
  [[ "$TCOUNT" -ge 2 ]] && { log "Boot reconcile loaded $TCOUNT triggers"; break; }
  sleep 1
  [[ $i -eq 5 ]] && fail "Boot reconcile did not load triggers within 5s"
done

# ---- Proof 1: Manual Trigger → real Run → real hooks → running/exited_ok ----
log ""
log "=== Proof 1: Manual Trigger ==="

MANUAL_RUN=$(fire_trigger "manual-smoke")
[[ "$MANUAL_RUN" == "null" || -z "$MANUAL_RUN" ]] && fail "Manual fire: no runId"
log "Manual Run created: $MANUAL_RUN"

# Wait for run to reach running or exited_ok (fast print-mode skill may complete quickly)
for i in $(seq 1 60); do
  MAN_STATE=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT state FROM runs WHERE id='$MANUAL_RUN'\").get();
    console.log(r ? r.state : 'none');
  " 2>/dev/null) || MAN_STATE="none"
  if [[ "$MAN_STATE" == "running" || "$MAN_STATE" == "exited_ok" ]]; then
    log "Manual Run state: $MAN_STATE (real CC session started)"
    break
  fi
  sleep 1
  [[ $i -eq 60 ]] && fail "Manual Run did not start within 60s"
done
# Ensure it reaches exited_ok
wait_run_state "$MANUAL_RUN" "exited_ok" 90
pass "Manual Trigger: Run $MANUAL_RUN → CC session → exited_ok (real CC hooks)"

MANUAL_ROW=$(query_db "SELECT id, trigger_id, step_ceiling, step_count, state FROM runs WHERE id='$MANUAL_RUN'")
log "Manual run row: $MANUAL_ROW"

# ---- Proof 2: Schedule Trigger ----
log ""
log "=== Proof 2: Schedule Trigger ==="

# Write schedule trigger (fires in 2 minutes from now, ensuring daemon tick sees it)
NEXT_MIN_UTC=$(python3 -c "
from datetime import datetime, timezone, timedelta
n = datetime.now(timezone.utc)
nxt = n.replace(second=0, microsecond=0) + timedelta(minutes=2)
print(f'{nxt.minute} {nxt.hour} * * *')
")
log "Schedule cron: '$NEXT_MIN_UTC'"

cat > "$VAULT/triggers/sched-smoke.md" << EOF
---
kind: schedule
skill: smoke-test
agent: default
cron_expr: "$NEXT_MIN_UTC"
step_ceiling: 30
---
EOF

# Wait for tick to reconcile (max 35s)
log "Waiting for tick to reconcile sched-smoke..."
for i in $(seq 1 35); do
  SCHED_EXIST=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT name FROM triggers WHERE name='sched-smoke'\").get();
    console.log(r ? 'yes' : 'no');
  " 2>/dev/null) || SCHED_EXIST="no"
  [[ "$SCHED_EXIST" == "yes" ]] && { log "sched-smoke reconciled after ${i}s"; break; }
  sleep 1
  [[ $i -eq 35 ]] && fail "sched-smoke not reconciled within 35s"
done

log "Waiting for scheduled fire (up to 150s)..."
SCHED_RUN="none"
for i in $(seq 1 150); do
  SCHED_RUN=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT id FROM runs WHERE trigger_id='sched-smoke' ORDER BY started_at DESC LIMIT 1\").get();
    console.log(r ? r.id : 'none');
  " 2>/dev/null) || SCHED_RUN="none"
  [[ "$SCHED_RUN" != "none" ]] && { log "Schedule Run created: $SCHED_RUN (at ${i}s)"; break; }
  sleep 1
  [[ $i -eq 150 ]] && fail "Schedule Trigger did not fire within 150s"
done

wait_run_state "$SCHED_RUN" "exited_ok" 60
SCHED_ROW=$(query_db "SELECT id, trigger_id, state FROM runs WHERE id='$SCHED_RUN'")
TRIG_ROW=$(query_db "SELECT name, last_fired_at, next_fire_at FROM triggers WHERE name='sched-smoke'")
log "Schedule run row: $SCHED_ROW"
log "Trigger row: $TRIG_ROW"
pass "Schedule Trigger: Run $SCHED_RUN fired at cron time → exited_ok (real CC hooks)"

# Kill the run (it's waiting for more turns)
tmux kill-session -t "vos-run-$SCHED_RUN" 2>/dev/null || true

# ---- Proof 3: Event Inbox ----
log ""
log "=== Proof 3: Event Inbox ==="

cat > "$VAULT/triggers/event-demo.md" << 'EOF'
---
kind: event
skill: smoke-test
agent: default
inbox: demo
step_ceiling: 30
---
EOF

log "Waiting for event-demo trigger to be reconciled (up to 35s)..."
for i in $(seq 1 35); do
  EV_EXIST=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT name FROM triggers WHERE name='event-demo'\").get();
    console.log(r ? 'yes' : 'no');
  " 2>/dev/null) || EV_EXIST="no"
  [[ "$EV_EXIST" == "yes" ]] && { log "event-demo reconciled after ${i}s"; break; }
  sleep 1
  [[ $i -eq 35 ]] && fail "event-demo not reconciled within 35s"
done

bash "$REPO/scripts/vos-inbox-append.sh" "$VAULT" demo '{"msg":"vos189-e2e"}'
log "Appended event to demo inbox"

EVENT_RUN="none"
for i in $(seq 1 60); do
  EVENT_RUN=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT id FROM runs WHERE trigger_id='event-demo' ORDER BY started_at DESC LIMIT 1\").get();
    console.log(r ? r.id : 'none');
  " 2>/dev/null) || EVENT_RUN="none"
  [[ "$EVENT_RUN" != "none" ]] && { log "Event Run created: $EVENT_RUN (at ${i}s)"; break; }
  sleep 1
  [[ $i -eq 60 ]] && fail "Event Trigger did not fire within 60s"
done

# Accept either running or exited_ok (fast print-mode skill may finish before we check)
for i in $(seq 1 30); do
  EV_STATE=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT state FROM runs WHERE id='$EVENT_RUN'\").get();
    console.log(r ? r.state : 'none');
  " 2>/dev/null) || EV_STATE="none"
  if [[ "$EV_STATE" == "running" || "$EV_STATE" == "exited_ok" ]]; then
    log "Event Run state: $EV_STATE (after ${i}s)"
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && fail "Event Run did not reach running/exited_ok within 30s; state=$EV_STATE"
done

EVENT_ROW=$(query_db "SELECT id, trigger_id, state FROM runs WHERE id='$EVENT_RUN'")
log "Event run row: $EVENT_ROW"
pass "Event Trigger: Run $EVENT_RUN fired on inbox append → real CC session (real hooks)"

tmux kill-session -t "vos-run-$EVENT_RUN" 2>/dev/null || true

# ---- Proof 4: Runaway Ceiling ----
log ""
log "=== Proof 4: Runaway Ceiling (step_ceiling=1, first Bash tool call triggers breach) ==="

CEIL_RUN=$(fire_trigger "ceiling-test")
[[ "$CEIL_RUN" == "null" || -z "$CEIL_RUN" ]] && fail "Ceiling fire: no runId"
log "Ceiling run: $CEIL_RUN"

wait_run_state "$CEIL_RUN" "exited_fail" 120

CEIL_ROW=$(query_db "SELECT id, trigger_id, step_count, step_ceiling, state, reason FROM runs WHERE id='$CEIL_RUN'")
log "Ceiling run row: $CEIL_ROW"

REASON=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query(\"SELECT reason FROM runs WHERE id='$CEIL_RUN'\").get();
  console.log(r ? r.reason : 'null');
" 2>/dev/null)
[[ "$REASON" != "runaway-ceiling" ]] && fail "Ceiling reason: expected 'runaway-ceiling', got '$REASON'"

TMUX_NAME="vos-run-$CEIL_RUN"
tmux has-session -t "$TMUX_NAME" 2>/dev/null && fail "Ceiling: tmux session still alive after breach" || true
pass "Runaway ceiling: Run $CEIL_RUN → exited_fail reason=runaway-ceiling (ceiling=1, first tool call), tmux gone"

# ---- Proof 5: Interactive Run exempt ----
log ""
log "=== Proof 5: Interactive Run exempt from ceiling ==="

INTER_LOC=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'skill=smoke-test&text=&runner=',
    redirect: 'manual',
  });
  console.log(r.headers.get('location') ?? '');
" 2>/dev/null)

SESSION_ID=$(echo "$INTER_LOC" | sed 's|/s/||')
[[ -z "$SESSION_ID" ]] && fail "Interactive launch: no session id"
log "Interactive session: $SESSION_ID"

sleep 3

INTER_ROW=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query(\"SELECT id,trigger_id,step_ceiling FROM runs WHERE session_id='$SESSION_ID' ORDER BY started_at DESC LIMIT 1\").get();
  console.log(JSON.stringify(r));
" 2>/dev/null)
log "Interactive run row: $INTER_ROW"

INTER_TRIG=$(echo "$INTER_ROW" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('trigger_id'); print('null' if v is None else str(v))" 2>/dev/null)
INTER_CEIL=$(echo "$INTER_ROW" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('step_ceiling'); print('null' if v is None else str(v))" 2>/dev/null)

[[ "$INTER_TRIG" != "null" ]] && fail "Interactive run: trigger_id should be null, got '$INTER_TRIG'"
[[ "$INTER_CEIL" != "null" ]] && fail "Interactive run: step_ceiling should be null, got '$INTER_CEIL'"
pass "Interactive Run: trigger_id=null, step_ceiling=null (exempt from ceiling)"

# Kill interactive run
INTER_RUN_ID=$(echo "$INTER_ROW" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [[ -n "$INTER_RUN_ID" && "$INTER_RUN_ID" != "null" ]]; then
  INTER_TMUX=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query(\"SELECT tmux_session FROM runs WHERE id='$INTER_RUN_ID'\").get();
    console.log(r ? r.tmux_session : '');
  " 2>/dev/null)
  [[ -n "$INTER_TMUX" ]] && tmux kill-session -t "$INTER_TMUX" 2>/dev/null || true
fi

# ---- Proof 6: Full unit test suite ----
log ""
log "=== Proof 6: Unit test regression ==="
cd "$REPO"
SUITE_OUT=$(bun run test 2>&1)
echo "$SUITE_OUT" >> "$LOG"
FAIL_COUNT=$(echo "$SUITE_OUT" | grep -oE "[0-9]+ fail" | grep -oE "^[0-9]+" | head -1 || echo "0")
PASS_COUNT=$(echo "$SUITE_OUT" | grep -oE "[0-9]+ pass" | grep -oE "^[0-9]+" | head -1 || echo "0")
[[ "$FAIL_COUNT" != "0" && -n "$FAIL_COUNT" ]] && fail "Unit test suite: $FAIL_COUNT failures"
pass "Full unit suite: $PASS_COUNT tests pass, 0 failures"

# ---- Summary ----
log ""
log "=== ALL PROOFS PASSED ==="
log ""
log "--- Final registry state ---"
query_db "SELECT id, trigger_id, step_count, step_ceiling, state, reason FROM runs ORDER BY started_at" | tee -a "$LOG"
log ""
log "Evidence log: $LOG"
