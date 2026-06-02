#!/usr/bin/env bash
# vos-proof-vos194.sh — VOS-194 async decision pipeline real-path proof. NO self-downgrade.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-proof-vos194.sh
#
# What it proves:
#   A. emit-decision-test skill execution (real CC, real hooks) → appends Decision to decisions.jsonl
#      + writes resumption-intent file (output_target) + notifies TG stub outbox.
#      Decision is surfaced on dashboard (listPendingDecisions returns it).
#   B. decision-reply bus line → drainInbox → routes to decision-reply-t trigger
#      → real continuation CC execution → reads intent, drains Decision, writes resume-done artifact
#      input_ref points at correct .void-os/bus/<id>.json; ended_at non-null.
#   C. rebuildExecutions deep-equals live rows for BOTH executions (emit + resume), incl input_ref
#   D. No regression: bun test --isolate full suite green
#
# Hard-fail on absent emit/park/resume. No self-downgrade.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos194-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14324
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos194-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/.claude"
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
log "=== VOS-194 decision pipeline real-path proof ==="
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

# ---- Setup: create vault + triggers BEFORE daemon start ----
log "Setting up vault at $VAULT..."
rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/.claude"
mkdir -p "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"

cat > "$VAULT/void-os.json" <<VAULTEOF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": ["emit-decision-test", "decision-resume"],
  "answers": {},
  "port": $PORT,
  "runners": [{"label": "vc (relay)", "command": "vc --"}],
  "defaultRunner": "vc (relay)"
}
VAULTEOF

# emit-decision-t: fires emit-decision-test on kind=idea lines (proof launcher — print mode)
cat > "$VAULT/triggers/emit-decision-t.md" << 'EOF'
---
kind: event
skill: emit-decision-test
agent: default
inbox: bus
event_kind: idea
step_ceiling: 30
---
emit-decision-t: fires the emit-decision-test skill on kind=idea bus lines (proof only).
EOF

# Copy catalog skills into the vault's .claude/skills so CC slash-command routing finds them.
# Also copy the vault CLAUDE.md so CC has the right cwd context.
mkdir -p "$VAULT/.claude/skills"
cp -r "$REPO/catalog/skills/emit-decision-test" "$VAULT/.claude/skills/"
cp -r "$REPO/catalog/skills/decision-resume" "$VAULT/.claude/skills/"
[[ -f "$REPO/templates/CLAUDE.md" ]] && cp "$REPO/templates/CLAUDE.md" "$VAULT/CLAUDE.md"

# decision-reply-t: fires decision-resume on kind=decision-reply bus lines
cat > "$VAULT/triggers/decision-reply-t.md" << 'EOF'
---
kind: event
skill: decision-resume
agent: default
inbox: bus
event_kind: decision-reply
step_ceiling: 30
---
decision-reply-t: fires the decision-resume continuation on kind=decision-reply bus lines.
EOF

# ---- Start daemon ----
log "Starting daemon (port $PORT)..."
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 25); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    fail "Daemon process $DAEMON_PID died before becoming ready"
  fi
  if bun --eval "const r = await fetch('$DAEMON_URL/').catch(()=>null); process.exit(r ? 0 : 1);" 2>/dev/null; then
    log "Daemon ready (pid $DAEMON_PID)"
    break
  fi
  sleep 1
  [[ $i -eq 25 ]] && fail "Daemon did not start within 25s"
done

# Verify both triggers loaded
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

DRT_KIND=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT event_kind FROM triggers WHERE name=?').get('decision-reply-t');
  console.log(r ? (r.event_kind ?? 'null') : 'missing');
" 2>/dev/null) || DRT_KIND="error"
[[ "$DRT_KIND" == "decision-reply" ]] || fail "decision-reply-t trigger event_kind not reconciled (got: $DRT_KIND)"
pass "decision-reply-t trigger has event_kind=decision-reply in registry"

EDT_KIND=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT event_kind FROM triggers WHERE name=?').get('emit-decision-t');
  console.log(r ? (r.event_kind ?? 'null') : 'missing');
" 2>/dev/null) || EDT_KIND="error"
[[ "$EDT_KIND" == "idea" ]] || fail "emit-decision-t trigger event_kind not reconciled (got: $EDT_KIND)"
pass "emit-decision-t trigger has event_kind=idea in registry"

BEFORE_EMIT=$(($(date +%s) * 1000))

# ---- Proof A: emit-decision-test execution parks ----
log ""
log "=== Proof A: emit-decision-test → Decision emitted + parked + surfaced ==="

# Fire the emitter via the bus trigger path (same path as 192 proof — print mode, fires hooks, exits cleanly).
log "Appending kind=idea bus line to fire emit-decision-t trigger..."
EMIT_BUS_ID=$(bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus idea "vos194 proof: fire emit-decision-test")
[[ -z "$EMIT_BUS_ID" ]] && fail "vos-bus-append.sh returned no id for emit trigger line"
log "Emit trigger bus line: $EMIT_BUS_ID"

# Wait for the emitter execution to appear in the registry
log "Waiting for emit-decision-t execution to appear (up to 90s)..."
EXEC_EMIT=$(poll_exec_for_trigger "emit-decision-t" "$BEFORE_EMIT" 90)
[[ "$EXEC_EMIT" == "none" || -z "$EXEC_EMIT" ]] && {
  log "Live triggers:"
  query_exec "SELECT name, kind, event_kind, enabled FROM triggers" | tee -a "$LOG"
  fail "emit-decision-t trigger did not fire an execution within 90s"
}
log "Emitter execution id: $EXEC_EMIT"
pass "Emitter execution created: $EXEC_EMIT"

# Wait for the emitter to park (clean exit = ended_at non-null)
log "Waiting for emitter execution to park (clean exit, max 180s)..."
if ! wait_exec_ended "$EXEC_EMIT" 180; then
  LIVE_ROW=$(query_exec "SELECT id, skill, started_at, ended_at FROM executions WHERE id='$EXEC_EMIT'")
  log "Live row at timeout: $LIVE_ROW"
  log "Last 20 lines of daemon log:"
  tail -20 "$LOG" || true
  fail "Emitter did not park (clean exit) within 180s"
fi
pass "Emitter execution parked (clean exit): $EXEC_EMIT"

# HARD-FAIL: Decision must be appended to decisions.jsonl
DEC_ID=$(bun --eval "
  const { listPendingDecisions } = require('$REPO/src/decision.ts');
  const p = listPendingDecisions('$VAULT').find(d => d.originExecId === '$EXEC_EMIT');
  console.log(p ? p.id : 'none');
" 2>/dev/null) || DEC_ID="none"
[[ "$DEC_ID" == "none" || -z "$DEC_ID" ]] && fail "No pending Decision emitted by $EXEC_EMIT — emit path did not run (decisions.jsonl absent or empty)"
pass "Decision emitted: $DEC_ID"

# HARD-FAIL: resumption-intent file must exist
INTENT="$VAULT/.void-os/resume/$EXEC_EMIT.json"
[[ -f "$INTENT" ]] || fail "Resumption-intent file missing: $INTENT — park did not write its output_target"
pass "Resumption-intent file written: $INTENT"

# HARD-FAIL: TG stub outbox must contain the Decision
TG_OUTBOX="$VAULT/.void-os/tg-outbox.jsonl"
[[ -f "$TG_OUTBOX" ]] || fail "TG outbox not written: $TG_OUTBOX — notifyDecision did not fire"
grep -q "$DEC_ID" "$TG_OUTBOX" || fail "Decision $DEC_ID not found in TG outbox — TG surface did not fire"
pass "Decision surfaced in TG stub outbox: $TG_OUTBOX"

# SURFACE check: listPendingDecisions returns it (same function dashboard uses)
STILL_PENDING_A=$(bun --eval "
  const { listPendingDecisions } = require('$REPO/src/decision.ts');
  console.log(listPendingDecisions('$VAULT').some(d => d.id === '$DEC_ID') ? 'yes' : 'no');
" 2>/dev/null) || STILL_PENDING_A="no"
[[ "$STILL_PENDING_A" == "yes" ]] || fail "Decision $DEC_ID not in pending list after emit — dashboard would not surface it"
pass "Decision $DEC_ID surfaces via listPendingDecisions (dashboard function)"

# ---- Proof B: decision-reply bus line drains Decision + fires continuation ----
log ""
log "=== Proof B: decision-reply bus line → drain Decision → continuation execution ==="

BEFORE_REPLY=$(($(date +%s) * 1000))

# Build and append a decision-reply bus line with routing to the parked Decision + origin exec.
# Note: vos-bus-append.sh has a ${5:-{}} bash parameter expansion bug when routing JSON contains '}'.
# We write the bus line directly here to sidestep it (same wire format).
REPLY_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
REPLY_TS=$(( $(date +%s) * 1000 ))
bun --eval "
  const fs = require('fs');
  const path = require('path');
  const line = JSON.stringify({
    channel: 'file', kind: 'decision-reply', payload: 'yes -- go ahead',
    routing: { decisionRef: '$DEC_ID', execRef: '$EXEC_EMIT' },
    id: '$REPLY_ID', ts: $REPLY_TS,
  });
  const dir = path.join('$VAULT', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'bus.jsonl'), line + '\n');
" 2>/dev/null || fail "failed to append decision-reply bus line"
[[ -z "$REPLY_ID" ]] && fail "failed to generate reply bus line id"
log "Decision-reply bus line appended: $REPLY_ID"
pass "Decision-reply bus line appended: $REPLY_ID"

# Wait for drainInbox to route to decision-reply-t and fire a continuation execution
log "Waiting for decision-resume continuation execution to appear (up to 120s)..."
EXEC_RESUME=$(poll_exec_for_trigger "decision-reply-t" "$BEFORE_REPLY" 120)
[[ "$EXEC_RESUME" == "none" || -z "$EXEC_RESUME" ]] && {
  log "Live triggers:"
  query_exec "SELECT name, kind, event_kind, enabled FROM triggers" | tee -a "$LOG"
  log "Inbox file:"
  cat "$VAULT/inbox/bus.jsonl" 2>/dev/null | tail -5 | tee -a "$LOG" || true
  fail "decision-reply bus line did not fire a continuation execution within 120s"
}
log "Continuation execution: $EXEC_RESUME"
pass "Continuation execution fired: $EXEC_RESUME"

# HARD-FAIL: input_ref points at the persisted bus-line file
REF_RESUME=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT input_ref FROM executions WHERE id=?').get('$EXEC_RESUME');
  console.log(r ? (r.input_ref ?? 'null') : 'null');
" 2>/dev/null)
EXPECTED_REF_RESUME="$VAULT/.void-os/bus/$REPLY_ID.json"
[[ "$REF_RESUME" == "$EXPECTED_REF_RESUME" ]] || fail "Continuation input_ref mismatch: got '$REF_RESUME' expected '$EXPECTED_REF_RESUME'"
pass "Continuation input_ref correct: $REF_RESUME"

# Wait for the continuation to complete via real CC hooks
log "Waiting for continuation execution to complete via real CC hooks (max 180s)..."
if ! wait_exec_ended "$EXEC_RESUME" 180; then
  LIVE_RESUME=$(query_exec "SELECT id, skill, started_at, ended_at, trigger_id, input_ref FROM executions WHERE id='$EXEC_RESUME'")
  log "Live row at timeout: $LIVE_RESUME"
  fail "Continuation did not complete (real CC hooks) within 180s"
fi
pass "Continuation completed via real CC hooks: $EXEC_RESUME"

# HARD-FAIL: Decision must now be drained (no longer pending)
STILL_PENDING_B=$(bun --eval "
  const { listPendingDecisions } = require('$REPO/src/decision.ts');
  console.log(listPendingDecisions('$VAULT').some(d => d.id === '$DEC_ID') ? 'yes' : 'no');
" 2>/dev/null) || STILL_PENDING_B="yes"
[[ "$STILL_PENDING_B" == "no" ]] || fail "Decision $DEC_ID still pending after continuation — drainDecision did not run"
pass "Decision drained: $DEC_ID"

# HARD-FAIL: resume-done artifact must exist and contain the resumption-intent payload
DONE_ART="$VAULT/.void-os/resume-done/$EXEC_RESUME.json"
[[ -f "$DONE_ART" ]] || fail "Resume-done artifact missing: $DONE_ART — continuation did not write its output_target"
grep -q "PROOF continuation" "$DONE_ART" || fail "Resume-done artifact did not contain the resumption-intent payload"
pass "Continuation consumed resumption-intent + wrote resume-done artifact: $DONE_ART"

# ---- Proof C: rebuild-from-file-log deep-equals live rows (BOTH execs) ----
log ""
log "=== Proof C: rebuildExecutions matches live rows (emit + resume execs) ==="

REBUILD_RESULT=$(bun --eval "
  const { openRegistry, getExecution } = require('$REPO/src/registry.ts');
  const { rebuildExecutions } = require('$REPO/src/events.ts');

  const live = openRegistry('$DB');
  const liveEmit = getExecution(live, '$EXEC_EMIT');
  const liveResume = getExecution(live, '$EXEC_RESUME');
  if (!liveEmit) { console.log('ERROR: live row EMIT not found'); process.exit(1); }
  if (!liveResume) { console.log('ERROR: live row RESUME not found'); process.exit(1); }

  const rebuilt = openRegistry(':memory:');
  rebuildExecutions(rebuilt, '$VAULT');
  const rebuiltEmit = getExecution(rebuilt, '$EXEC_EMIT');
  const rebuiltResume = getExecution(rebuilt, '$EXEC_RESUME');
  if (!rebuiltEmit) { console.log('ERROR: rebuilt row EMIT not found'); process.exit(1); }
  if (!rebuiltResume) { console.log('ERROR: rebuilt row RESUME not found'); process.exit(1); }

  const fields = ['id', 'skill', 'started_at', 'ended_at', 'step_count', 'trigger_id', 'input_ref'];
  const mismatches = [];
  for (const f of fields) {
    if (liveEmit[f] !== rebuiltEmit[f]) mismatches.push('EMIT.' + f + ': live=' + liveEmit[f] + ' rebuilt=' + rebuiltEmit[f]);
    if (liveResume[f] !== rebuiltResume[f]) mismatches.push('RESUME.' + f + ': live=' + liveResume[f] + ' rebuilt=' + rebuiltResume[f]);
  }
  if (mismatches.length > 0) { console.log('MISMATCH: ' + mismatches.join(', ')); process.exit(1); }
  if (rebuiltEmit.ended_at == null) { console.log('ERROR: rebuilt EMIT ended_at null'); process.exit(1); }
  if (rebuiltResume.ended_at == null) { console.log('ERROR: rebuilt RESUME ended_at null'); process.exit(1); }
  if (rebuiltResume.input_ref == null) { console.log('ERROR: rebuilt RESUME input_ref null'); process.exit(1); }
  console.log('MATCH: EMIT.id=' + rebuiltEmit.id + ' RESUME.id=' + rebuiltResume.id + ' RESUME.input_ref=' + rebuiltResume.input_ref);
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
log "=== VOS-194 PROOF SUMMARY ==="
log "Vault:          $VAULT"
log "Decision:       $DEC_ID"
log "Exec EMIT:      $EXEC_EMIT  (emitter — parked)"
log "Exec RESUME:    $EXEC_RESUME  input_ref=$REF_RESUME"
log "Resume-done:    $DONE_ART"
log "Decisions file: $VAULT/.void-os/decisions.jsonl  (drained)"
log "TG outbox:      $TG_OUTBOX"
log "Rebuild:        MATCH (both execs, incl input_ref, ended_at)"
log "Unit suite:     green"
log "All checks passed — VOS-194 decision pipeline proven end-to-end (emit→park→surface→reply→resume→drain)"
