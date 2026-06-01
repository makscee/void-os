#!/usr/bin/env bash
# vos-proof-vos191.sh — VOS-191 real-path proof: output-target declaration + Stop-hook nudge.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-proof-vos191.sh
#
# What it proves:
#   Run MUTATE: trigger-fired execution with output-smoke-write skill writes the declared
#     output_target on turn 1 → produced_change=1, nudged=0, ended cleanly, no nudge.
#   Run NUDGE: trigger-fired execution with output-smoke-skip skill does NOT write target
#     on turn 1 → Stop-hook nudge fires (nudged=1), CC continues, target eventually produced
#     (or ceiling hit) → execution ends.
#   Both: rebuild-from-file-log deep-equals live row (id, skill, started_at, ended_at,
#     produced_change, nudged). Proof script hard-fails if nudge never fires (nudged=0).
#
# MANDATORY genuine real-path: real CC process fires Stop hooks — no hand-firing.
# NO partial-proof fallback: if expected states are absent, exits NON-ZERO.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos191-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14321
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos191-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  rm -rf "$VAULT/.void-os" "$VAULT/.claude" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/out"
}
trap cleanup EXIT

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
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
  local name="$1" interactive="${2:-}"
  local url="$DAEMON_URL/triggers/$name/fire"
  [[ "$interactive" == "interactive" ]] && url="${url}?interactive=1"
  local resp
  resp=$(bun --eval "
    const r = await fetch('$url', { method: 'POST' });
    const j = await r.json();
    console.log(JSON.stringify(j));
  " 2>/dev/null)
  echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('runId','null'))" 2>/dev/null
}

# Wait for nudged=1 on an execution. Returns 0 on success, 1 on timeout.
wait_exec_nudged() {
  local exec_id="$1" deadline=$((SECONDS + $2))
  while [[ $SECONDS -lt $deadline ]]; do
    local nudged
    nudged=$(bun --eval "
      const { Database } = require('bun:sqlite');
      const db = new Database('$DB');
      const r = db.query('SELECT nudged FROM executions WHERE id=?').get('$exec_id');
      console.log(r ? r.nudged : 'none');
    " 2>/dev/null) || nudged="error"
    [[ "$nudged" == "1" ]] && return 0
    sleep 2
  done
  return 1
}

# Assert produced_change and nudged columns on an execution row (HARD-FAIL if mismatch).
assert_row() {
  local exec_id="$1" expected_produced="$2" expected_nudged="$3"
  local got
  got=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    const r = db.query('SELECT produced_change,nudged FROM executions WHERE id=?').get('$exec_id');
    console.log(r ? r.produced_change + ',' + r.nudged : 'none');
  " 2>/dev/null)
  [[ "$got" == "${expected_produced},${expected_nudged}" ]] || \
    fail "row $exec_id expected produced=$expected_produced nudged=$expected_nudged, got $got"
  pass "row $exec_id: produced_change=$expected_produced nudged=$expected_nudged ✓"
}

# Assert event log has an output-check line with expected values.
assert_output_check_event() {
  local exec_id="$1" expected_produced="$2" expected_nudged="$3"
  local event_log="$VAULT/.void-os/events/$exec_id.jsonl"
  [[ ! -f "$event_log" ]] && fail "Event log not found: $event_log"
  local line
  line=$(grep '"type":"output-check"' "$event_log" || echo "")
  [[ -z "$line" ]] && fail "No output-check event in event log for $exec_id"
  local got_produced got_nudged
  got_produced=$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(1 if d['produced_change'] else 0)" 2>/dev/null)
  got_nudged=$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(1 if d['nudged'] else 0)" 2>/dev/null)
  [[ "$got_produced" == "$expected_produced" && "$got_nudged" == "$expected_nudged" ]] || \
    fail "output-check event for $exec_id: expected produced=$expected_produced nudged=$expected_nudged, got produced=$got_produced nudged=$got_nudged. Line: $line"
  pass "output-check event for $exec_id: produced=$expected_produced nudged=$expected_nudged ✓"
}

# Assert rebuildExecutions deep-equals live row (hard-fail on mismatch).
assert_rebuild_matches() {
  local exec_id="$1"
  local result
  result=$(bun --eval "
    const { openRegistry, getExecution } = require('$REPO/src/registry.ts');
    const { rebuildExecutions } = require('$REPO/src/events.ts');
    const live = openRegistry('$DB');
    const liveRow = getExecution(live, '$exec_id');
    if (!liveRow) { console.log('ERROR: live row not found'); process.exit(1); }
    const rebuilt = openRegistry(':memory:');
    rebuildExecutions(rebuilt, '$VAULT');
    const rebuiltRow = getExecution(rebuilt, '$exec_id');
    if (!rebuiltRow) { console.log('ERROR: rebuilt row not found'); process.exit(1); }
    const fields = ['id', 'skill', 'started_at', 'ended_at', 'step_count', 'trigger_id', 'produced_change', 'nudged'];
    const mismatches = [];
    for (const f of fields) {
      if (liveRow[f] !== rebuiltRow[f]) mismatches.push(f + ': live=' + liveRow[f] + ' rebuilt=' + rebuiltRow[f]);
    }
    if (mismatches.length > 0) { console.log('MISMATCH: ' + mismatches.join(', ')); process.exit(1); }
    if (rebuiltRow.ended_at == null) { console.log('ERROR: rebuilt ended_at null'); process.exit(1); }
    console.log('MATCH: id=' + rebuiltRow.id + ' produced_change=' + rebuiltRow.produced_change + ' nudged=' + rebuiltRow.nudged);
  " 2>&1)
  if echo "$result" | grep -q "^MATCH:"; then
    pass "rebuildExecutions matches live row for $exec_id: $result"
  elif echo "$result" | grep -q "^MISMATCH:\|^ERROR:"; then
    fail "rebuildExecutions failed for $exec_id: $result"
  else
    fail "rebuildExecutions unexpected output for $exec_id: $result"
  fi
}

rm -f "$LOG"
log "=== VOS-191 real-path proof ==="
log "Repo: $REPO"
log "Vault: $VAULT"

# ---- Preflight: vc auth check ----
log "Checking vc auth..."
VC_STATUS=$(vc status 2>&1 || true)
log "vc status: $VC_STATUS"
if echo "$VC_STATUS" | grep -q "logged in\|authenticated\|authed"; then
  pass "vc authenticated"
else
  log "WARNING: vc may not be authenticated — proof will still run"
fi

# ---- Setup: create vault with void-os.json + triggers + installed skills ----
log "Setting up vault at $VAULT..."
mkdir -p "$VAULT/triggers" "$VAULT/out"
# Install proof skills into vault .claude/skills so CC recognizes them as slash commands.
mkdir -p "$VAULT/.claude/skills/output-smoke-write" "$VAULT/.claude/skills/output-smoke-skip"
cp "$REPO/catalog/skills/output-smoke-write/SKILL.md" "$VAULT/.claude/skills/output-smoke-write/SKILL.md"
cp "$REPO/catalog/skills/output-smoke-skip/SKILL.md" "$VAULT/.claude/skills/output-smoke-skip/SKILL.md"
cat > "$VAULT/void-os.json" <<VAULTEOF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": ["output-smoke-write", "output-smoke-skip"],
  "answers": {},
  "port": $PORT,
  "runners": [{"label": "vc (relay)", "command": "claude --dangerously-skip-permissions"}],
  "defaultRunner": "vc (relay)"
}
VAULTEOF

# Write triggers BEFORE daemon starts (boot reconcile loads them).
cat > "$VAULT/triggers/vos191-write.md" << 'EOF'
---
kind: manual
skill: output-smoke-write
agent: default
step_ceiling: 20
---
EOF

cat > "$VAULT/triggers/vos191-skip.md" << 'EOF'
---
kind: manual
skill: output-smoke-skip
agent: default
step_ceiling: 20
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

# Verify boot reconcile loaded both triggers
for i in $(seq 1 5); do
  TCOUNT=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    console.log(db.query('SELECT count(*) as n FROM triggers').get().n);
  " 2>/dev/null) || TCOUNT=0
  [[ "$TCOUNT" -ge 2 ]] && { log "Boot reconcile loaded $TCOUNT trigger(s)"; break; }
  sleep 1
  [[ $i -eq 5 ]] && fail "Boot reconcile did not load both triggers within 5s"
done

# ============================================================
# === Run MUTATE: fire output-smoke-write, expect produced_change=1, nudged=0 ===
# ============================================================
log ""
log "=== Run MUTATE: fire output-smoke-write ==="

MUTATE_EXEC_ID=$(fire_trigger "vos191-write")
[[ "$MUTATE_EXEC_ID" == "null" || -z "$MUTATE_EXEC_ID" ]] && fail "MUTATE trigger fire returned no runId"
log "MUTATE Execution ID: $MUTATE_EXEC_ID"

# Wait for execution to end (max 180s — includes CC cold-start)
log "Waiting for MUTATE execution to end (max 180s)..."
if ! wait_exec_ended "$MUTATE_EXEC_ID" 180; then
  LIVE=$(query_exec "SELECT id, skill, started_at, ended_at, produced_change, nudged FROM executions WHERE id='$MUTATE_EXEC_ID'")
  log "Live row at timeout: $LIVE"
  fail "MUTATE execution did not complete within 180s"
fi
pass "MUTATE execution ended"

# Assert: produced_change=1, nudged=0
assert_row "$MUTATE_EXEC_ID" "1" "0"

# Assert: event log has output-check with produced=1 nudged=0
assert_output_check_event "$MUTATE_EXEC_ID" "1" "0"

# Assert: rebuild matches live
assert_rebuild_matches "$MUTATE_EXEC_ID"

log "Full MUTATE event log:"
cat "$VAULT/.void-os/events/$MUTATE_EXEC_ID.jsonl" | tee -a "$LOG"

# ============================================================
# === Run NUDGE: fire via /launch (interactive, non-print), expect nudged=1 ===
# NOTE: print-mode (trigger-fired) does not fire the CC Stop hook. Interactive mode required.
# ============================================================
log ""
log "=== Run NUDGE: fire output-smoke-skip in interactive mode (?interactive=1 — Stop fires) ==="
log "(Print-mode does not fire CC Stop; interactive mode is required for nudge verification)"

NUDGE_EXEC_ID=$(fire_trigger "vos191-skip" "interactive")
[[ "$NUDGE_EXEC_ID" == "null" || -z "$NUDGE_EXEC_ID" ]] && fail "NUDGE trigger fire returned no runId"
log "NUDGE Execution ID: $NUDGE_EXEC_ID"
NUDGE_SESSION="vos-run-$NUDGE_EXEC_ID"

# CC interactive mode shows a workspace trust dialog on first launch.
# Sequence: wait for dialog → send Enter to accept → then send the skill text as the first prompt.
# The skill was passed as a positional arg but gets "eaten" if the trust dialog appears first.
log "Waiting 6s for trust dialog, then accepting and sending skill prompt..."
sleep 6
# Check if the session is still alive
if ! tmux has-session -t "$NUDGE_SESSION" 2>/dev/null; then
  fail "NUDGE tmux session '$NUDGE_SESSION' is not alive after 6s — CC may have crashed"
fi
log "Session alive. Sending Enter to accept any trust dialog..."
tmux send-keys -t "$NUDGE_SESSION" "" Enter 2>/dev/null || true
sleep 4
# After trust dialog is accepted, CC is at the interactive prompt. Send the skill text.
log "Sending /output-smoke-skip prompt to CC interactive session..."
tmux send-keys -t "$NUDGE_SESSION" "/output-smoke-skip" Enter 2>/dev/null || true
log "Skill prompt sent. Waiting for CC to process first turn (Stop should fire after turn 1)."

# Wait for nudged=1 (max 240s — Stop fires when CC finishes first turn; nudge re-prompts turn 2)
log "Waiting for NUDGE nudged=1 (max 240s)..."
if ! wait_exec_nudged "$NUDGE_EXEC_ID" 240; then
  LIVE=$(query_exec "SELECT id, skill, started_at, ended_at, produced_change, nudged FROM executions WHERE id='$NUDGE_EXEC_ID'")
  log "Live row at timeout: $LIVE"
  cat "$VAULT/.void-os/events/$NUDGE_EXEC_ID.jsonl" 2>/dev/null | tee -a "$LOG" || true
  fail "NUDGE: nudged never set to 1 within 180s — Stop hook did not block the stop. Hard failure."
fi
pass "NUDGE: nudged=1 confirmed (real Stop hook nudged the execution)"

# Wait for execution to end (CC may write file on turn 2 or run until ceiling/kill)
log "Waiting for NUDGE execution to end (max 180s — ceiling, SessionEnd, or kill)..."
if ! wait_exec_ended "$NUDGE_EXEC_ID" 180; then
  # Kill the session to force termination — interactive sessions stay alive; explicit stop is fine.
  log "NUDGE session still alive after nudge — killing via /s/$NUDGE_EXEC_ID/stop"
  curl -s -X POST "$DAEMON_URL/s/$NUDGE_EXEC_ID/stop" > /dev/null 2>&1 || true
  sleep 15
  if ! wait_exec_ended "$NUDGE_EXEC_ID" 30; then
    # Also try killing tmux session directly
    log "Still not ended — killing tmux session directly"
    tmux kill-session -t "$NUDGE_SESSION" 2>/dev/null || true
    sleep 10
    if ! wait_exec_ended "$NUDGE_EXEC_ID" 15; then
      LIVE=$(query_exec "SELECT id, skill, started_at, ended_at, produced_change, nudged FROM executions WHERE id='$NUDGE_EXEC_ID'")
      log "Live row: $LIVE"
      fail "NUDGE execution did not end even after stop + tmux kill"
    fi
  fi
fi
pass "NUDGE execution ended"

# Assert: nudged=1 (hard-fail if nudge never fired — belt+suspenders)
NUDGE_ROW=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT produced_change,nudged FROM executions WHERE id=?').get('$NUDGE_EXEC_ID');
  console.log(r ? r.produced_change + ',' + r.nudged : 'none');
" 2>/dev/null)
NUDGE_VAL=$(echo "$NUDGE_ROW" | cut -d, -f2)
[[ "$NUDGE_VAL" != "1" ]] && fail "NUDGE execution: nudged=$NUDGE_VAL — nudge never fired (expected nudged=1). This is a hard failure: the Stop hook did not block the stop."
pass "NUDGE execution: nudged=1 (nudge fired) ✓"

# Record produced_change (may be 1 if agent wrote after nudge, or 0 if ceiling/kill)
PRODUCED_VAL=$(echo "$NUDGE_ROW" | cut -d, -f1)
log "NUDGE produced_change=$PRODUCED_VAL (1=wrote after nudge; 0=ceiling/kill — both valid)"

# Assert: event log has output-check with nudged=1
EVENT_LOG="$VAULT/.void-os/events/$NUDGE_EXEC_ID.jsonl"
[[ ! -f "$EVENT_LOG" ]] && fail "NUDGE event log not found: $EVENT_LOG"
NUDGE_CHECK_LINE=$(grep '"type":"output-check"' "$EVENT_LOG" | tail -1 || echo "")
[[ -z "$NUDGE_CHECK_LINE" ]] && fail "NUDGE: no output-check event in event log $EVENT_LOG"
pass "NUDGE: output-check event present in event log"

# Verify the first output-check line has nudged=true (the nudge event)
FIRST_CHECK=$(grep '"type":"output-check"' "$EVENT_LOG" | head -1)
FIRST_NUDGED=$(echo "$FIRST_CHECK" | python3 -c "import json,sys; d=json.load(sys.stdin); print(1 if d['nudged'] else 0)" 2>/dev/null)
[[ "$FIRST_NUDGED" == "1" ]] || fail "NUDGE: first output-check event has nudged=$FIRST_NUDGED, expected 1. Real nudge did not fire. Line: $FIRST_CHECK"
pass "NUDGE: first output-check event has nudged=1 (real Stop hook nudge confirmed) ✓"

# Assert: rebuild matches live
assert_rebuild_matches "$NUDGE_EXEC_ID"

log "Full NUDGE event log:"
cat "$EVENT_LOG" | tee -a "$LOG"

# ============================================================
# === Summary ===
# ============================================================
log ""
log "=== VOS-191 PROOF SUMMARY ==="
log "MUTATE exec: $MUTATE_EXEC_ID"
log "  produced_change=1, nudged=0 ✓"
log "  output-check event in log ✓"
log "  rebuild matches live ✓"
log ""
log "NUDGE exec:  $NUDGE_EXEC_ID"
log "  nudged=1 (real Stop hook fired) ✓"
log "  output-check event with nudged=1 ✓"
log "  rebuild matches live ✓"
log ""
log "All VOS-191 checks passed — output-target + Stop-hook nudge proven end-to-end with real CC hooks"
log "Proof log: $LOG"
