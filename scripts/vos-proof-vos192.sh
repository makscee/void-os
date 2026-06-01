#!/usr/bin/env bash
# vos-proof-vos192.sh — VOS-192 inbound-bus real-path proof. NO self-downgrade.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-proof-vos192.sh
#
# What it proves:
#   A. file-channel bus line (channel=file, kind=idea) → drainInbox → routes to idea-t trigger
#      → real CC execution (trigger-fired, print mode) → real hooks walk start→end
#      → input_ref points at persisted .void-os/bus/<id>.json file
#   B. reference-adapter (channel=web, kind=chat) → same path → routes to chat-t trigger
#      → real CC execution → real hooks walk start→end → input_ref correct
#   C. rebuild-from-file-log deep-equals live rows for BOTH executions, incl input_ref
#   D. No regression: bun test --isolate full suite green
#
# Hard-fail on absent firing, no self-downgrade. Mirrors vos-proof-vos190.sh exactly.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos192-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14322
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos192-proof.log"
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

# Poll for an execution whose trigger_id matches, created after AFTER_TS. Returns exec id or "none".
poll_exec_for_trigger() {
  local trigger_name="$1" after_ts="$2" deadline=$((SECONDS + $3))
  while [[ $SECONDS -lt $deadline ]]; do
    local exec_id
    exec_id=$(bun --eval "
      const { Database } = require('bun:sqlite');
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE trigger_id=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('$trigger_name', $after_ts);
      console.log(r ? r.id : 'none');
    " 2>/dev/null) || exec_id="none"
    [[ "$exec_id" != "none" && -n "$exec_id" ]] && { echo "$exec_id"; return 0; }
    sleep 2
  done
  echo "none"
}

rm -f "$LOG"
log "=== VOS-192 inbound-bus real-path proof ==="
log "Repo: $REPO"
log "Vault: $VAULT"
log "Port: $PORT"

# Kill any stale process on our proof port before we start
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# ---- Preflight: vc auth check ----
log "Checking vc auth..."
if ! vc status 2>/dev/null | grep -q "authenticated\|authed\|ok"; then
  if ! bun --eval "
    const fs = require('fs');
    const token = fs.readFileSync(process.env.HOME + '/.claudev/token', 'utf8').trim();
    const r = await fetch('https://auth.makscee.ru/v1/auth-check', {headers:{Authorization:'Bearer '+token}}).catch(()=>null);
    const ok = r && r.status < 400;
    console.log(ok ? 'ok' : 'fail');
  " 2>/dev/null | grep -q "ok"; then
    log "WARNING: vc may not be authenticated — proceeding (daemon will show auth error if unauthenticated)"
  fi
fi

# ---- Setup: create vault + two event triggers BEFORE daemon start ----
log "Setting up vault at $VAULT..."
rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"
mkdir -p "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"

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

# idea-t: matches kind=idea lines on inbox "bus"
cat > "$VAULT/triggers/idea-t.md" << 'EOF'
---
kind: event
skill: smoke-test
agent: default
inbox: bus
event_kind: idea
step_ceiling: 30
---
EOF

# chat-t: matches kind=chat lines on inbox "bus" (proves reference adapter / second channel)
cat > "$VAULT/triggers/chat-t.md" << 'EOF'
---
kind: event
skill: smoke-test
agent: default
inbox: bus
event_kind: chat
step_ceiling: 30
---
EOF

# ---- Start daemon ----
log "Starting daemon (port $PORT)..."
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 25); do
  # Check our daemon process is still alive (EADDRINUSE would have killed it)
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    fail "Daemon process $DAEMON_PID died before becoming ready — check log for EADDRINUSE or other startup error"
  fi
  if bun --eval "const r = await fetch('$DAEMON_URL/').catch(()=>null); process.exit(r ? 0 : 1);" 2>/dev/null; then
    log "Daemon ready (pid $DAEMON_PID)"
    break
  fi
  sleep 1
  [[ $i -eq 25 ]] && fail "Daemon did not start within 25s"
done

# Verify boot reconcile loaded BOTH triggers
for i in $(seq 1 10); do
  TCOUNT=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    console.log(db.query('SELECT count(*) as n FROM triggers').get().n);
  " 2>/dev/null) || TCOUNT=0
  [[ "$TCOUNT" -ge 2 ]] && { log "Boot reconcile loaded $TCOUNT trigger(s)"; break; }
  sleep 1
  [[ $i -eq 10 ]] && fail "Boot reconcile did not load both triggers within 10s (got $TCOUNT)"
done

# Verify event_kind was reconciled (VOS-192 new column)
IDEA_KIND=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT event_kind FROM triggers WHERE name=?').get('idea-t');
  console.log(r ? (r.event_kind ?? 'null') : 'missing');
" 2>/dev/null) || IDEA_KIND="error"
[[ "$IDEA_KIND" == "idea" ]] || fail "idea-t trigger event_kind not reconciled (got: $IDEA_KIND)"
pass "idea-t trigger has event_kind=idea in registry"

CHAT_KIND=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT event_kind FROM triggers WHERE name=?').get('chat-t');
  console.log(r ? (r.event_kind ?? 'null') : 'missing');
" 2>/dev/null) || CHAT_KIND="error"
[[ "$CHAT_KIND" == "chat" ]] || fail "chat-t trigger event_kind not reconciled (got: $CHAT_KIND)"
pass "chat-t trigger has event_kind=chat in registry"

BEFORE_TS=$(($(date +%s) * 1000))

# ---- Proof A: file-channel bus line fires idea-t ----
log ""
log "=== Proof A: file-channel (channel=file, kind=idea) → idea-t trigger ==="

ID_A=$(bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus idea "vos192 file-channel idea proof")
[[ -z "$ID_A" ]] && fail "file-channel append returned no id"
log "Bus line ID: $ID_A"

# Wait for drainInbox to pick up the line and fire an execution (daemon tick is 30s; we
# also call the reconcile/drain inline — poll up to 90s for the execution to appear).
log "Waiting for idea-t execution to appear (up to 90s)..."
EXEC_A=$(poll_exec_for_trigger "idea-t" "$BEFORE_TS" 90)
[[ "$EXEC_A" == "none" || -z "$EXEC_A" ]] && {
  log "Live triggers:"
  query_exec "SELECT name, kind, event_kind, enabled FROM triggers" | tee -a "$LOG"
  log "Inbox file:"
  cat "$VAULT/inbox/bus.jsonl" | tee -a "$LOG" || true
  fail "file-channel line did not fire an execution for idea-t within 90s"
}
log "Execution A: $EXEC_A"
pass "file-channel line fired execution: $EXEC_A"

# Verify started_at set
STARTED_A=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT started_at FROM executions WHERE id=?').get('$EXEC_A');
  console.log(r ? r.started_at : 'null');
" 2>/dev/null)
[[ "$STARTED_A" == "null" || -z "$STARTED_A" ]] && fail "Execution A row not found or started_at null"
pass "Execution A started_at=$STARTED_A"

# Verify input_ref points at the correct .void-os/bus/<id>.json file
REF_A=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT input_ref FROM executions WHERE id=?').get('$EXEC_A');
  console.log(r ? (r.input_ref ?? 'null') : 'null');
" 2>/dev/null)
EXPECTED_REF_A="$VAULT/.void-os/bus/$ID_A.json"
[[ "$REF_A" == "$EXPECTED_REF_A" ]] || fail "Execution A input_ref mismatch: got '$REF_A' expected '$EXPECTED_REF_A'"
pass "Execution A input_ref correct: $REF_A"

[[ -f "$REF_A" ]] || fail "Bus line file missing: $REF_A"
REF_KIND_A=$(bun --eval "const f=require('fs');const l=JSON.parse(f.readFileSync('$REF_A','utf8'));console.log(l.kind);" 2>/dev/null)
[[ "$REF_KIND_A" == "idea" ]] || fail "Bus line file kind mismatch: got '$REF_KIND_A' expected 'idea'"
pass "Bus line file exists + kind=idea: $REF_A"

# Wait for real CC hooks to walk start→end (print mode exits cleanly)
log "Waiting for Execution A to complete via real CC hooks (max 120s)..."
if ! wait_exec_ended "$EXEC_A" 120; then
  LIVE_ROW_A=$(query_exec "SELECT id, skill, started_at, ended_at, trigger_id, input_ref FROM executions WHERE id='$EXEC_A'")
  log "Live row at timeout: $LIVE_ROW_A"
  fail "Execution A did not complete within 120s — real CC hooks did not fire start→end"
fi
pass "Execution A completed via real CC hooks"

# Verify event log
EVENT_LOG_A="$VAULT/.void-os/events/$EXEC_A.jsonl"
[[ ! -f "$EVENT_LOG_A" ]] && fail "Event log A not found: $EVENT_LOG_A"
grep -q '"type":"start"' "$EVENT_LOG_A" || fail "No start event in event log A"
grep -q '"type":"end"\|"type":"fail"' "$EVENT_LOG_A" || fail "No end/fail event in event log A"
pass "Event log A has start+end events"

# ---- Proof B: reference adapter (channel=web, kind=chat) fires chat-t ----
log ""
log "=== Proof B: reference adapter (channel=web, kind=chat) → chat-t trigger ==="

BEFORE_B=$(($(date +%s) * 1000))
ID_B=$(bash "$REPO/scripts/vos-bus-adapter-ref.sh" "$VAULT" bus chat "vos192 ref-adapter chat proof")
[[ -z "$ID_B" ]] && fail "ref-adapter append returned no id"
log "Bus line ID: $ID_B"

log "Waiting for chat-t execution to appear (up to 90s)..."
EXEC_B=$(poll_exec_for_trigger "chat-t" "$BEFORE_B" 90)
[[ "$EXEC_B" == "none" || -z "$EXEC_B" ]] && {
  log "Inbox file after append:"
  cat "$VAULT/inbox/bus.jsonl" | tee -a "$LOG" || true
  fail "ref-adapter line did not fire an execution for chat-t within 90s"
}
log "Execution B: $EXEC_B"
pass "ref-adapter line fired execution: $EXEC_B"

STARTED_B=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT started_at FROM executions WHERE id=?').get('$EXEC_B');
  console.log(r ? r.started_at : 'null');
" 2>/dev/null)
[[ "$STARTED_B" == "null" || -z "$STARTED_B" ]] && fail "Execution B row not found or started_at null"
pass "Execution B started_at=$STARTED_B"

REF_B=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT input_ref FROM executions WHERE id=?').get('$EXEC_B');
  console.log(r ? (r.input_ref ?? 'null') : 'null');
" 2>/dev/null)
EXPECTED_REF_B="$VAULT/.void-os/bus/$ID_B.json"
[[ "$REF_B" == "$EXPECTED_REF_B" ]] || fail "Execution B input_ref mismatch: got '$REF_B' expected '$EXPECTED_REF_B'"
pass "Execution B input_ref correct: $REF_B"

[[ -f "$REF_B" ]] || fail "Bus line file B missing: $REF_B"
REF_CHANNEL_B=$(bun --eval "const f=require('fs');const l=JSON.parse(f.readFileSync('$REF_B','utf8'));console.log(l.channel);" 2>/dev/null)
[[ "$REF_CHANNEL_B" == "web" ]] || fail "Bus line file B channel mismatch: got '$REF_CHANNEL_B' expected 'web'"
pass "Bus line file B exists + channel=web: $REF_B"

log "Waiting for Execution B to complete via real CC hooks (max 120s)..."
if ! wait_exec_ended "$EXEC_B" 120; then
  LIVE_ROW_B=$(query_exec "SELECT id, skill, started_at, ended_at, trigger_id, input_ref FROM executions WHERE id='$EXEC_B'")
  log "Live row at timeout: $LIVE_ROW_B"
  fail "Execution B did not complete within 120s — real CC hooks did not fire start→end"
fi
pass "Execution B completed via real CC hooks"

EVENT_LOG_B="$VAULT/.void-os/events/$EXEC_B.jsonl"
[[ ! -f "$EVENT_LOG_B" ]] && fail "Event log B not found: $EVENT_LOG_B"
grep -q '"type":"start"' "$EVENT_LOG_B" || fail "No start event in event log B"
grep -q '"type":"end"\|"type":"fail"' "$EVENT_LOG_B" || fail "No end/fail event in event log B"
pass "Event log B has start+end events"

# ---- Proof C: rebuild-from-file-log deep-equals live (BOTH execs, incl input_ref) ----
log ""
log "=== Proof C: rebuildExecutions matches live rows (both execs, incl input_ref) ==="

REBUILD_RESULT=$(bun --eval "
  const { openRegistry, getExecution } = require('$REPO/src/registry.ts');
  const { rebuildExecutions } = require('$REPO/src/events.ts');

  const live = openRegistry('$DB');
  const liveA = getExecution(live, '$EXEC_A');
  const liveB = getExecution(live, '$EXEC_B');
  if (!liveA) { console.log('ERROR: live row A not found'); process.exit(1); }
  if (!liveB) { console.log('ERROR: live row B not found'); process.exit(1); }

  const rebuilt = openRegistry(':memory:');
  rebuildExecutions(rebuilt, '$VAULT');
  const rebuiltA = getExecution(rebuilt, '$EXEC_A');
  const rebuiltB = getExecution(rebuilt, '$EXEC_B');
  if (!rebuiltA) { console.log('ERROR: rebuilt row A not found'); process.exit(1); }
  if (!rebuiltB) { console.log('ERROR: rebuilt row B not found'); process.exit(1); }

  const fields = ['id', 'skill', 'started_at', 'ended_at', 'step_count', 'trigger_id', 'input_ref'];
  const mismatches = [];
  for (const f of fields) {
    if (liveA[f] !== rebuiltA[f]) mismatches.push('A.' + f + ': live=' + liveA[f] + ' rebuilt=' + rebuiltA[f]);
    if (liveB[f] !== rebuiltB[f]) mismatches.push('B.' + f + ': live=' + liveB[f] + ' rebuilt=' + rebuiltB[f]);
  }
  if (mismatches.length > 0) {
    console.log('MISMATCH: ' + mismatches.join(', '));
    process.exit(1);
  }
  if (rebuiltA.ended_at == null) { console.log('ERROR: rebuilt A ended_at null'); process.exit(1); }
  if (rebuiltB.ended_at == null) { console.log('ERROR: rebuilt B ended_at null'); process.exit(1); }
  if (rebuiltA.input_ref == null) { console.log('ERROR: rebuilt A input_ref null'); process.exit(1); }
  if (rebuiltB.input_ref == null) { console.log('ERROR: rebuilt B input_ref null'); process.exit(1); }
  console.log('MATCH: A.id=' + rebuiltA.id + ' A.input_ref=' + rebuiltA.input_ref + ' B.id=' + rebuiltB.id + ' B.input_ref=' + rebuiltB.input_ref);
" 2>&1)

if echo "$REBUILD_RESULT" | grep -q "^MATCH:"; then
  pass "rebuildExecutions matches live rows: $REBUILD_RESULT"
elif echo "$REBUILD_RESULT" | grep -q "^MISMATCH:"; then
  fail "rebuildExecutions MISMATCH: $REBUILD_RESULT"
else
  fail "rebuildExecutions failed: $REBUILD_RESULT"
fi

# ---- Proof D: no-regression — full unit suite ----
log ""
log "=== Proof D: no-regression — bun test --isolate ==="
cd "$REPO"
if bun test --isolate 2>&1 | tee -a "$LOG" | grep -E "^[[:space:]]*[0-9]+ fail" | grep -v " 0 fail"; then
  fail "Unit test suite has failures — see $LOG"
fi
pass "Unit test suite green"

# ---- Summary ----
log ""
log "=== VOS-192 PROOF SUMMARY ==="
log "Vault:         $VAULT"
log "Exec A (idea): $EXEC_A  input_ref=$REF_A"
log "Exec B (chat): $EXEC_B  input_ref=$REF_B"
log "Rebuild:       MATCH (both execs, incl input_ref, ended_at, trigger_id)"
log "Unit suite:    green"
log "All checks passed — VOS-192 inbound-bus proven end-to-end (file-channel + ref-adapter)"
