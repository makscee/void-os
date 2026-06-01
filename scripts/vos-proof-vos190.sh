#!/usr/bin/env bash
# vos-proof-vos190.sh — VOS-190 real-path proof: real CC execution start→end + rebuild-matches-live.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-proof-vos190.sh
#
# What it proves:
#   1. spawnRun (via trigger-fired POST /triggers/<name>/fire) creates an executions row
#      with started_at set — uses print mode (-p) so CC exits cleanly without trust dialog
#   2. Real CC hooks (SessionStart, SessionEnd/ProcessExit) walk the row start→end
#   3. The file-level event log (.void-os/events/<execId>.jsonl) has start AND end lines
#   4. rebuildExecutions on a fresh :memory: db deep-equals the live row (id, skill,
#      started_at, ended_at, step_count, trigger_id all match)
#   5. Schema hygiene: no runs/sessions tables in registry DB
#
# MANDATORY genuine real-path: a real CC process fires the hooks — no hand-firing.
# NO partial-proof fallback: if ended_at is never set or end event never written, exits NON-ZERO.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos190-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14320
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos190-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"
}
trap cleanup EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

query_exec() {
  bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const rows = db.query(\"$1\").all();
    console.log(JSON.stringify(rows, null, 2));
  " 2>/dev/null
}

# Wait for execution ended_at to be non-null. Returns 0 on success, 1 on timeout.
# Does NOT self-downgrade — caller must treat non-zero return as hard failure.
wait_exec_ended() {
  local exec_id="$1" deadline=$((SECONDS + $2))
  while [[ $SECONDS -lt $deadline ]]; do
    local ended
    ended=$(bun --eval "
      const { Database } = require('bun:sqlite');
      const db = new Database('$DB');
      const r = db.query('SELECT ended_at FROM executions WHERE id=?').get('$exec_id');
      console.log(r ? (r.ended_at != null ? 'ended' : 'running') : 'none');
    " 2>/dev/null) || ended="error"
    [[ "$ended" == "ended" ]] && return 0
    sleep 2
  done
  return 1
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

rm -f "$LOG"
log "=== VOS-190 real-path proof ==="
log "Repo: $REPO"
log "Vault: $VAULT"
log "Using trigger-fired (print-mode) execution to guarantee start→end without trust dialog"

# ---- Preflight: vc auth check ----
log "Checking vc auth..."
if ! vc status 2>/dev/null | grep -q "authenticated\|authed\|ok"; then
  if ! curl -sf "https://auth.makscee.ru/v1/auth-check" -H "Authorization: Bearer $(cat ~/.claudev/token 2>/dev/null)" 2>/dev/null | grep -q "ok\|valid\|true"; then
    log "WARNING: vc may not be authenticated — proceeding anyway (daemon will show auth error on /fire)"
  fi
fi

# ---- Setup: create vault with void-os.json + smoke-test trigger ----
log "Setting up vault at $VAULT..."
mkdir -p "$VAULT/triggers"
cat > "$VAULT/void-os.json" <<VAULTEOF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": ["smoke-test"],
  "answers": {},
  "port": $PORT,
  "runners": [{"label": "vc (relay)", "command": "vc --"}],
  "defaultRunner": "vc (relay)"
}
VAULTEOF

# Write trigger BEFORE daemon starts (boot reconcile loads it).
# kind:manual + skill:smoke-test → trigger-fired → isPrint=true → CC uses -p → exits cleanly.
cat > "$VAULT/triggers/vos190-smoke.md" << 'EOF'
---
kind: manual
skill: smoke-test
agent: default
step_ceiling: 30
---
EOF

# ---- Start daemon ----
log "Starting daemon (port $PORT)..."
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 20); do
  if bun --eval "const r = await fetch('$DAEMON_URL/').catch(()=>null); process.exit(r ? 0 : 1);" 2>/dev/null; then
    log "Daemon ready (pid $DAEMON_PID)"
    break
  fi
  sleep 1
  [[ $i -eq 20 ]] && fail "Daemon did not start within 20s"
done

# Verify boot reconcile loaded trigger
for i in $(seq 1 5); do
  TCOUNT=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    console.log(db.query('SELECT count(*) as n FROM triggers').get().n);
  " 2>/dev/null) || TCOUNT=0
  [[ "$TCOUNT" -ge 1 ]] && { log "Boot reconcile loaded $TCOUNT trigger(s)"; break; }
  sleep 1
  [[ $i -eq 5 ]] && fail "Boot reconcile did not load triggers within 5s"
done

# ---- Proof 1: Trigger-fired spawnRun creates execution row ----
log "--- Proof 1: POST /triggers/vos190-smoke/fire → executions row ---"

EXEC_ID=$(fire_trigger "vos190-smoke")
[[ "$EXEC_ID" == "null" || -z "$EXEC_ID" ]] && fail "trigger fire returned no runId"
log "Execution ID: $EXEC_ID"

# Verify execution row exists with started_at set
STARTED=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT started_at FROM executions WHERE id=?').get('$EXEC_ID');
  console.log(r ? r.started_at : 'null');
" 2>/dev/null)

[[ "$STARTED" == "null" || -z "$STARTED" ]] && fail "Execution row not found or started_at is null"
pass "Execution row exists: started_at=$STARTED"

# ---- Proof 2: Wait for real CC hooks to walk start→end ----
log "--- Proof 2: Waiting for real CC hooks (start→end, max 120s) ---"
# NO fallback — if CC does not fire SessionEnd/ProcessExit within the timeout, this is a genuine
# failure. Trigger-fired (print-mode) execution exits after the skill completes — no trust dialog.
if ! wait_exec_ended "$EXEC_ID" 120; then
  LIVE_ROW=$(query_exec "SELECT id, skill, started_at, ended_at, step_count, trigger_id FROM executions WHERE id='$EXEC_ID'")
  log "Live row at timeout: $LIVE_ROW"
  fail "Execution did not complete within 120s — ended_at never set. Real CC hooks did not fire start→end. See daemon log: $LOG"
fi

pass "Execution ended via real CC hooks"

# Print the live row
log "Live execution row:"
query_exec "SELECT id, skill, started_at, ended_at, step_count, trigger_id FROM executions WHERE id='$EXEC_ID'" | tee -a "$LOG"

# ---- Proof 3: Event log file exists with BOTH start AND end lines ----
log "--- Proof 3: Event log files-first check ---"
EVENT_LOG="$VAULT/.void-os/events/$EXEC_ID.jsonl"
[[ ! -f "$EVENT_LOG" ]] && fail "Event log file not found: $EVENT_LOG"
pass "Event log file exists: $EVENT_LOG"

START_LINE=$(grep '"type":"start"' "$EVENT_LOG" || echo "")
[[ -z "$START_LINE" ]] && fail "No start event in event log $EVENT_LOG"
pass "Event log has start event: $START_LINE"

END_LINE=$(grep '"type":"end"\|"type":"fail"' "$EVENT_LOG" || echo "")
[[ -z "$END_LINE" ]] && fail "No end/fail event in event log $EVENT_LOG — real CC hooks did not fire end event. Log: $(cat "$EVENT_LOG")"
pass "Event log has end/fail event: $END_LINE"

log "Full event log:"
cat "$EVENT_LOG" | tee -a "$LOG"

# ---- Proof 4: rebuildExecutions matches live row ----
log "--- Proof 4: rebuildExecutions matches live row ---"
REBUILD_RESULT=$(bun --eval "
  const { openRegistry, getExecution } = require('$REPO/src/registry.ts');
  const { rebuildExecutions } = require('$REPO/src/events.ts');

  // Get live row from real DB
  const live = openRegistry('$DB');
  const liveRow = getExecution(live, '$EXEC_ID');
  if (!liveRow) { console.log('ERROR: live row not found'); process.exit(1); }

  // Rebuild into fresh :memory: DB from event files
  const rebuilt = openRegistry(':memory:');
  rebuildExecutions(rebuilt, '$VAULT');
  const rebuiltRow = getExecution(rebuilt, '$EXEC_ID');
  if (!rebuiltRow) { console.log('ERROR: rebuilt row not found — event log did not produce a row'); process.exit(1); }

  // Compare key fields — ALL must match (ended_at must be non-null in both)
  const fields = ['id', 'skill', 'started_at', 'ended_at', 'step_count', 'trigger_id', 'input_ref'];
  const mismatches = [];
  for (const f of fields) {
    if (liveRow[f] !== rebuiltRow[f]) {
      mismatches.push(f + ': live=' + liveRow[f] + ' rebuilt=' + rebuiltRow[f]);
    }
  }
  if (mismatches.length > 0) {
    console.log('MISMATCH: ' + mismatches.join(', '));
    process.exit(1);
  }
  if (rebuiltRow.ended_at == null) {
    console.log('ERROR: rebuilt row ended_at is null — rebuild did not reproduce the end event');
    process.exit(1);
  }
  console.log('MATCH: id=' + rebuiltRow.id + ' skill=' + rebuiltRow.skill + ' started_at=' + rebuiltRow.started_at + ' ended_at=' + rebuiltRow.ended_at + ' step_count=' + rebuiltRow.step_count);
" 2>&1)

if echo "$REBUILD_RESULT" | grep -q "^MATCH:"; then
  pass "rebuildExecutions matches live row: $REBUILD_RESULT"
elif echo "$REBUILD_RESULT" | grep -q "^MISMATCH:"; then
  fail "rebuildExecutions MISMATCH: $REBUILD_RESULT"
else
  # ERROR: or unexpected output — hard fail, no silent pass
  fail "rebuildExecutions failed: $REBUILD_RESULT"
fi

# ---- Proof 5: No resume token, no sessions/runs tables ----
log "--- Proof 5: Schema hygiene — no sessions/runs tables ---"
TABLES=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const rows = db.query(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
  console.log(rows.map(r => r.name).join(','));
" 2>/dev/null)
log "Tables in registry: $TABLES"
if echo "$TABLES" | grep -q "runs\|sessions"; then
  fail "Old tables (runs/sessions) still present in registry"
fi
pass "Schema clean: no runs/sessions tables (found: $TABLES)"

# ---- Summary ----
log ""
log "=== VOS-190 PROOF SUMMARY ==="
log "Execution ID:     $EXEC_ID"
log "started_at:       $STARTED"
log "ended_at:         set (real CC hooks confirmed)"
log "Event log:        $EVENT_LOG (start + end lines present)"
log "Rebuild:          MATCH (all key fields equal)"
log "Tables:           $TABLES"
log "All checks passed — VOS-190 executions model proven end-to-end with real CC start→end"
