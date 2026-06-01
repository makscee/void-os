#!/usr/bin/env bash
# vos-proof-vos195.sh — VOS-195 idea→task-file real-path proof. NO self-downgrade.
#
# Requires: vc authenticated, tmux, bun, void-os daemon source.
# Usage: bash scripts/vos-proof-vos195.sh
#
# What it proves:
#   A. file-channel bus line (channel=file, kind=idea) → drainInbox → routes to idea-intake
#      trigger → real CC execution (trigger-fired) → real hooks walk start→end →
#      a NEW well-formed task file appears in vault/work/tasks/backlog/ →
#      executions row has produced_change=1, nudged=0, input_ref → .void-os/bus/<id>.json.
#   B. no-output variant: a kind=idea line whose payload is whitespace-only → execution fires,
#      writes nothing → Stop-hook nudges once (nudged=1) → still nothing → ends with
#      produced_change=0, nudged=1. (Asserts the VOS-191 single-nudge-then-give-up path.)
#   C. rebuild-from-file-log deep-equals live rows for BOTH executions (incl input_ref,
#      produced_change, nudged).
#   D. No regression: bun test --isolate full suite green.
#
# Hard-fail on absent task creation / wrong bools. No self-downgrade.
# Mirrors vos-proof-vos192.sh structure exactly.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos195-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14325
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos195-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  rm -rf "$VAULT/.void-os" "$VAULT/.claude" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/vault"
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
log "=== VOS-195 idea→task-file real-path proof ==="
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

# ---- Setup: create vault + idea-intake trigger + hub task dirs BEFORE daemon start ----
log "Setting up vault at $VAULT..."
rm -rf "$VAULT/.void-os" "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/.claude" "$VAULT/vault"
mkdir -p "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions"
# Create hub task backlog dir that the skill writes into
mkdir -p "$VAULT/vault/work/tasks/backlog"
mkdir -p "$VAULT/vault/work/tasks/active"
mkdir -p "$VAULT/vault/work/tasks/completed"
# Install the idea-intake skill into the vault's .claude/skills/ so CC recognizes /idea-intake
mkdir -p "$VAULT/.claude/skills/idea-intake"
cp "$REPO/catalog/skills/idea-intake/SKILL.md" "$VAULT/.claude/skills/idea-intake/SKILL.md"

cat > "$VAULT/void-os.json" <<VAULTEOF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": ["idea-intake"],
  "answers": {},
  "port": $PORT,
  "runners": [{"label": "vc (relay)", "command": "vc --"}],
  "defaultRunner": "vc (relay)"
}
VAULTEOF

# idea-intake event trigger: fires on kind=idea bus lines
cat > "$VAULT/triggers/idea-intake.md" << 'EOF'
---
kind: event
skill: idea-intake
agent: default
inbox: bus
event_kind: idea
step_ceiling: 30
---
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

# Verify boot reconcile loaded the idea-intake trigger
for i in $(seq 1 10); do
  TCOUNT=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const db = new Database('$DB');
    console.log(db.query('SELECT count(*) as n FROM triggers').get().n);
  " 2>/dev/null) || TCOUNT=0
  [[ "$TCOUNT" -ge 1 ]] && { log "Boot reconcile loaded $TCOUNT trigger(s)"; break; }
  sleep 1
  [[ $i -eq 10 ]] && fail "Boot reconcile did not load idea-intake trigger within 10s (got $TCOUNT)"
done

INTAKE_KIND=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT event_kind FROM triggers WHERE name=?').get('idea-intake');
  console.log(r ? (r.event_kind ?? 'null') : 'missing');
" 2>/dev/null) || INTAKE_KIND="error"
[[ "$INTAKE_KIND" == "idea" ]] || fail "idea-intake trigger event_kind not reconciled (got: $INTAKE_KIND)"
pass "idea-intake trigger has event_kind=idea in registry"

BEFORE_TS=$(($(date +%s) * 1000))

# ---- Proof A: happy path — real idea → real task file created ----
log ""
log "=== Proof A: idea bus line → idea-intake trigger → real task file in backlog ==="

IDEA_PAYLOAD="add a /reports page that lists generated HTML reports"
ID_A=$(bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus idea "$IDEA_PAYLOAD")
[[ -z "$ID_A" ]] && fail "file-channel append returned no id"
log "Bus line ID: $ID_A"

log "Waiting for idea-intake execution to appear (up to 90s)..."
EXEC_A=$(poll_exec_for_trigger "idea-intake" "$BEFORE_TS" 90)
[[ "$EXEC_A" == "none" || -z "$EXEC_A" ]] && {
  log "Live triggers:"
  query_exec "SELECT name, kind, event_kind, enabled FROM triggers" | tee -a "$LOG"
  log "Inbox file:"
  cat "$VAULT/inbox/bus.jsonl" | tee -a "$LOG" || true
  fail "idea bus line did not fire an execution for idea-intake within 90s"
}
log "Execution A: $EXEC_A"
pass "idea bus line fired execution: $EXEC_A"

STARTED_A=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT started_at FROM executions WHERE id=?').get('$EXEC_A');
  console.log(r ? r.started_at : 'null');
" 2>/dev/null)
[[ "$STARTED_A" == "null" || -z "$STARTED_A" ]] && fail "Execution A row not found or started_at null"
pass "Execution A started_at=$STARTED_A"

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

log "Waiting for Execution A to complete via real CC hooks (max 180s)..."
if ! wait_exec_ended "$EXEC_A" 180; then
  LIVE_ROW_A=$(query_exec "SELECT id, skill, started_at, ended_at, trigger_id, input_ref FROM executions WHERE id='$EXEC_A'")
  log "Live row at timeout: $LIVE_ROW_A"
  fail "Execution A did not complete within 180s — real CC hooks did not fire start→end"
fi
pass "Execution A completed via real CC hooks"

# HARD-ASSERT: a new task file must exist in the backlog
BACKLOG_DIR="$VAULT/vault/work/tasks/backlog"
NEW_FILES=$(find "$BACKLOG_DIR" -name "*.md" -newer "$VAULT/void-os.json" 2>/dev/null | wc -l | tr -d ' ')
[[ "$NEW_FILES" -lt 1 ]] && fail "Proof A HARD FAIL: no new task file appeared in $BACKLOG_DIR after idea execution (got $NEW_FILES new files)"
TASK_FILE=$(find "$BACKLOG_DIR" -name "*.md" -newer "$VAULT/void-os.json" | head -1)
log "Task file created: $TASK_FILE"

# Verify the task file has the required frontmatter and sections
grep -q 'id:' "$TASK_FILE" || fail "Task file missing 'id:' in frontmatter: $TASK_FILE"
grep -q 'title:' "$TASK_FILE" || fail "Task file missing 'title:' in frontmatter: $TASK_FILE"
grep -q 'state: backlog' "$TASK_FILE" || fail "Task file missing 'state: backlog': $TASK_FILE"
grep -q '## Done when' "$TASK_FILE" || fail "Task file missing '## Done when' section: $TASK_FILE"
grep -q '## Why' "$TASK_FILE" || fail "Task file missing '## Why' section: $TASK_FILE"
pass "Task file is well-formed: $(basename "$TASK_FILE")"

# Verify produced_change=1, nudged=0 on the execution row
PC_A=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT produced_change, nudged FROM executions WHERE id=?').get('$EXEC_A');
  console.log(r ? r.produced_change + ',' + r.nudged : 'null');
" 2>/dev/null)
[[ "$PC_A" == "1,0" ]] || fail "Execution A produced_change/nudged wrong: got '$PC_A' expected '1,0'"
pass "Execution A produced_change=1, nudged=0"

EVENT_LOG_A="$VAULT/.void-os/events/$EXEC_A.jsonl"
[[ ! -f "$EVENT_LOG_A" ]] && fail "Event log A not found: $EVENT_LOG_A"
grep -q '"type":"start"' "$EVENT_LOG_A" || fail "No start event in event log A"
grep -q '"type":"end"\|"type":"fail"' "$EVENT_LOG_A" || fail "No end/fail event in event log A"
pass "Event log A has start+end events"

# ---- Proof B: no-output nudge — whitespace-only payload → no task file, nudge=1 ----
log ""
log "=== Proof B: whitespace idea → no task file → nudge once → produced_change=0, nudged=1 ==="

BEFORE_B=$(($(date +%s) * 1000))
# Whitespace payload — passes bus line parsing (non-empty string) but skill writes nothing
ID_B=$(bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus idea "   ")
[[ -z "$ID_B" ]] && fail "file-channel append (whitespace) returned no id"
log "Bus line ID (whitespace): $ID_B"

log "Waiting for idea-intake execution B to appear (up to 90s)..."
EXEC_B=$(poll_exec_for_trigger "idea-intake" "$BEFORE_B" 90)
[[ "$EXEC_B" == "none" || -z "$EXEC_B" ]] && {
  fail "whitespace idea bus line did not fire an execution for idea-intake within 90s"
}
log "Execution B: $EXEC_B"
pass "whitespace idea bus line fired execution: $EXEC_B"

log "Waiting for Execution B to complete via real CC hooks (max 240s — nudge adds one extra turn)..."
if ! wait_exec_ended "$EXEC_B" 240; then
  LIVE_ROW_B=$(query_exec "SELECT id, skill, started_at, ended_at, trigger_id, nudged, produced_change FROM executions WHERE id='$EXEC_B'")
  log "Live row at timeout: $LIVE_ROW_B"
  fail "Execution B did not complete within 240s"
fi
pass "Execution B completed via real CC hooks"

# HARD-ASSERT: produced_change=0, nudged=1
PC_B=$(bun --eval "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB');
  const r = db.query('SELECT produced_change, nudged FROM executions WHERE id=?').get('$EXEC_B');
  console.log(r ? r.produced_change + ',' + r.nudged : 'null');
" 2>/dev/null)
[[ "$PC_B" == "0,1" ]] || fail "Execution B produced_change/nudged wrong: got '$PC_B' expected '0,1' (nudge not triggered or file was written)"
pass "Execution B produced_change=0, nudged=1 (nudge path confirmed)"

# HARD-ASSERT: no additional backlog file appeared during Proof B
NEW_FILES_B=$(find "$BACKLOG_DIR" -name "*.md" -newer "$TASK_FILE" 2>/dev/null | wc -l | tr -d ' ')
[[ "$NEW_FILES_B" -gt 0 ]] && fail "Proof B HARD FAIL: $NEW_FILES_B new task file(s) appeared during whitespace-idea run (should be 0)"
pass "No spurious task file created during whitespace-idea run"

EVENT_LOG_B="$VAULT/.void-os/events/$EXEC_B.jsonl"
[[ ! -f "$EVENT_LOG_B" ]] && fail "Event log B not found: $EVENT_LOG_B"
grep -q '"type":"start"' "$EVENT_LOG_B" || fail "No start event in event log B"
grep -q '"type":"end"\|"type":"fail"' "$EVENT_LOG_B" || fail "No end/fail event in event log B"
pass "Event log B has start+end events"

# ---- Proof C: rebuild-from-file-log deep-equals live (BOTH execs, incl produced_change, nudged) ----
log ""
log "=== Proof C: rebuildExecutions matches live rows (both execs, incl produced_change, nudged) ==="

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

  const fields = ['id', 'skill', 'started_at', 'ended_at', 'step_count', 'trigger_id', 'input_ref', 'produced_change', 'nudged'];
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
  if (rebuiltA.produced_change !== 1) { console.log('ERROR: rebuilt A produced_change not 1: ' + rebuiltA.produced_change); process.exit(1); }
  if (rebuiltB.produced_change !== 0) { console.log('ERROR: rebuilt B produced_change not 0: ' + rebuiltB.produced_change); process.exit(1); }
  if (rebuiltB.nudged !== 1) { console.log('ERROR: rebuilt B nudged not 1: ' + rebuiltB.nudged); process.exit(1); }
  console.log('MATCH: A.id=' + rebuiltA.id + ' A.produced_change=' + rebuiltA.produced_change + ' B.id=' + rebuiltB.id + ' B.produced_change=' + rebuiltB.produced_change + ' B.nudged=' + rebuiltB.nudged);
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
log "=== VOS-195 PROOF SUMMARY ==="
log "Vault:                  $VAULT"
log "Exec A (happy path):    $EXEC_A  produced_change=1, nudged=0"
log "Task file created:      $(basename "$TASK_FILE")"
log "Exec B (nudge path):    $EXEC_B  produced_change=0, nudged=1"
log "Rebuild:                MATCH (both execs, incl produced_change, nudged, input_ref)"
log "Unit suite:             green"
log "All checks passed — VOS-195 idea→task-file proven end-to-end (real idea + no-output nudge)"
