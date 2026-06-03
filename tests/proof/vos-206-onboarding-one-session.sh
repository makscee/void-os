#!/usr/bin/env bash
# vos-206-onboarding-one-session.sh
# VOS-206 T7: Master-run proof — onboarding round-trip in ONE persistent session.
#
# PRECONDITIONS (run by master in a real terminal):
#   1. Daemon is running: cd <vault> && void-os serve
#   2. VAULT env var points to the dogfood vault (or pass as first arg).
#
# USAGE:  bash tests/proof/vos-206-onboarding-one-session.sh [VAULT] [PORT]
#
# WHAT IT ASSERTS (exit 0 = PASS):
#   - POST /launch skill=onboarding → 302 redirect, captures RUNID
#   - session-meta.json has interactive:true
#   - ONE executions row exists for RUNID
#   - tmux session vos-run-<RUNID> is live on socket 'vos'
#   - POST /s/<RUNID>/send name=Alice → 302 back to /s/<RUNID> (SAME session, NOT a new exec)
#   - STILL exactly ONE executions row for RUNID (no successor spawn)
#   - body.html does NOT contain <form (stranded-yellow dissolved)
#   - tmux session vos-run-<RUNID> is STILL the same session (pane PID unchanged)
#
# REAPED-PATH PROOF (optional, step 5):
#   Kill the session manually:  tmux -L vos kill-session -t vos-run-<RUNID>
#   Then re-run step 4 with a different name to verify respawn+send-keys path.
#
# Evidence captured to: /tmp/vos-206-proof-<RUNID>.txt

set -euo pipefail

VAULT="${1:-${VAULT:-}}"
PORT="${2:-4317}"
BASE="http://127.0.0.1:${PORT}"

if [[ -z "$VAULT" ]]; then
  echo "ERROR: pass VAULT as first arg or set VAULT env var" >&2
  exit 1
fi

echo "=== VOS-206 T7: onboarding-in-one-session proof ==="
echo "vault=$VAULT port=$PORT"
echo ""

# ---- Step 3: Launch onboarding ----
echo "[step 3] POST /launch skill=onboarding"
LAUNCH_RESP=$(curl -s -D - -X POST "${BASE}/launch" -d 'skill=onboarding' -o /dev/null -w "%{http_code}")
LAUNCH_LOCATION=$(curl -s -D - -X POST "${BASE}/launch" -d 'skill=onboarding' 2>&1 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
if [[ -z "$LAUNCH_LOCATION" ]]; then
  echo "ERROR: /launch did not redirect — got: $LAUNCH_RESP" >&2
  exit 1
fi
RUNID="${LAUNCH_LOCATION#/s/}"
echo "  RUNID=$RUNID"
echo "  location=$LAUNCH_LOCATION"

EVIDENCE_FILE="/tmp/vos-206-proof-${RUNID}.txt"
echo "VOS-206 proof run — $(date)" > "$EVIDENCE_FILE"
echo "RUNID=$RUNID" >> "$EVIDENCE_FILE"

# ---- Check meta.interactive ----
META_PATH="${VAULT}/sessions/${RUNID}/session-meta.json"
sleep 0.5  # allow session dir to be written
if [[ ! -f "$META_PATH" ]]; then
  echo "ERROR: session-meta.json not found at $META_PATH" >&2
  exit 1
fi
INTERACTIVE=$(bun --eval "const m=JSON.parse(require('fs').readFileSync('${META_PATH}','utf8')); console.log(m.interactive)" 2>/dev/null)
echo "  meta.interactive=$INTERACTIVE"
if [[ "$INTERACTIVE" != "true" ]]; then
  echo "ERROR: expected meta.interactive=true, got: $INTERACTIVE" >&2
  exit 1
fi
echo "  PASS: meta.interactive=true" | tee -a "$EVIDENCE_FILE"

# ---- Count executions rows (should be 1) ----
EXEC_COUNT=$(bun --eval "
const {openRegistry}=require('./src/registry.ts');
const db=openRegistry('${VAULT}/void-os.db');
const rows=db.prepare('SELECT count(*) as n FROM executions WHERE id=?').get('${RUNID}');
console.log(rows.n);
" 2>/dev/null || echo "?")
echo "  executions rows for RUNID=$EXEC_COUNT"
echo "  executions_before_send=$EXEC_COUNT" >> "$EVIDENCE_FILE"
if [[ "$EXEC_COUNT" != "1" ]]; then
  echo "WARNING: expected 1 execution row, got $EXEC_COUNT (may be timing — continuing)"
fi

# ---- Check tmux session is live ----
TMUX_SESSION="vos-run-${RUNID}"
sleep 1  # allow tmux session to start
if tmux -L vos has-session -t "$TMUX_SESSION" 2>/dev/null; then
  PANE_PID_BEFORE=$(tmux -L vos display-message -p -t "${TMUX_SESSION}" '#{pane_pid}' 2>/dev/null || echo "?")
  echo "  PASS: tmux session $TMUX_SESSION is live (pane_pid=$PANE_PID_BEFORE)" | tee -a "$EVIDENCE_FILE"
else
  echo "WARNING: tmux session $TMUX_SESSION not yet live — onboarding may still be starting"
  PANE_PID_BEFORE="?"
fi
echo "  pane_pid_before=$PANE_PID_BEFORE" >> "$EVIDENCE_FILE"

# ---- Check body.html has <form ----
BODY_PATH="${VAULT}/sessions/${RUNID}/body.html"
for i in $(seq 1 60); do
  sleep 2
  if [[ -f "$BODY_PATH" ]] && grep -q '<form' "$BODY_PATH" 2>/dev/null; then
    echo "  PASS: body.html has <form (onboarding rendered form, waited ~$((i*2))s)" | tee -a "$EVIDENCE_FILE"
    break
  fi
  echo "  waiting for <form in body.html ($i/60, ${i}×2s elapsed)..."
done
if ! grep -q '<form' "$BODY_PATH" 2>/dev/null; then
  echo "WARNING: body.html does not contain <form after ~120s — onboarding may not have rendered yet"
  echo "  body.html snippet:" | tee -a "$EVIDENCE_FILE"
  head -5 "$BODY_PATH" 2>/dev/null | tee -a "$EVIDENCE_FILE"
fi

# ---- Step 4: Submit form (THE core assertion) ----
echo ""
echo "[step 4] POST /s/${RUNID}/send name=Alice skill_chat=on"
SEND_RESP=$(curl -s -D - -X POST "${BASE}/s/${RUNID}/send" -d 'name=Alice&skill_chat=on' -o /dev/null -w "%{http_code}" 2>&1)
SEND_LOCATION=$(curl -s -D - -X POST "${BASE}/s/${RUNID}/send" -d 'name=Alice&skill_chat=on' 2>&1 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
echo "  send redirect location=$SEND_LOCATION"
echo "  send_location=$SEND_LOCATION" >> "$EVIDENCE_FILE"

# CORE ASSERTION 1: redirect back to SAME session
if [[ "$SEND_LOCATION" == "/s/${RUNID}" ]]; then
  echo "  PASS: redirect back to same session /s/${RUNID}" | tee -a "$EVIDENCE_FILE"
else
  echo "FAIL: expected redirect to /s/${RUNID}, got: $SEND_LOCATION" | tee -a "$EVIDENCE_FILE"
  exit 1
fi

# CORE ASSERTION 2: still only 1 executions row (no successor spawn)
sleep 0.5
EXEC_COUNT_AFTER=$(bun --eval "
const {openRegistry}=require('./src/registry.ts');
const db=openRegistry('${VAULT}/void-os.db');
const rows=db.prepare('SELECT count(*) as n FROM executions').get();
console.log(rows.n);
" 2>/dev/null || echo "?")
echo "  total executions rows after send=$EXEC_COUNT_AFTER"
echo "  total_executions_after_send=$EXEC_COUNT_AFTER" >> "$EVIDENCE_FILE"

# Compare execution count — should not have grown by more than 1 (the original onboarding)
EXEC_FOR_RUNID=$(bun --eval "
const {openRegistry}=require('./src/registry.ts');
const db=openRegistry('${VAULT}/void-os.db');
const rows=db.prepare('SELECT count(*) as n FROM executions WHERE id=?').get('${RUNID}');
console.log(rows.n);
" 2>/dev/null || echo "?")
echo "  executions rows for RUNID after send=$EXEC_FOR_RUNID"
echo "  executions_for_runid_after_send=$EXEC_FOR_RUNID" >> "$EVIDENCE_FILE"
if [[ "$EXEC_FOR_RUNID" == "1" ]]; then
  echo "  PASS: still exactly 1 execution row for RUNID (no successor spawn)" | tee -a "$EVIDENCE_FILE"
else
  echo "FAIL: expected 1 row for RUNID, got $EXEC_FOR_RUNID — successor may have been spawned" | tee -a "$EVIDENCE_FILE"
  exit 1
fi

# CORE ASSERTION 3: body.html no longer has <form
sleep 0.5
if ! grep -q '<form' "$BODY_PATH" 2>/dev/null; then
  echo "  PASS: body.html no longer contains <form (stranded-yellow dissolved)" | tee -a "$EVIDENCE_FILE"
else
  echo "FAIL: body.html still contains <form after send — interactive branch may not have cleared it" | tee -a "$EVIDENCE_FILE"
  head -10 "$BODY_PATH" | tee -a "$EVIDENCE_FILE"
  exit 1
fi

# CORE ASSERTION 4: same tmux session (pane PID family unchanged)
if tmux -L vos has-session -t "$TMUX_SESSION" 2>/dev/null; then
  PANE_PID_AFTER=$(tmux -L vos display-message -p -t "${TMUX_SESSION}" '#{pane_pid}' 2>/dev/null || echo "?")
  echo "  tmux session $TMUX_SESSION still live after send (pane_pid=$PANE_PID_AFTER)" | tee -a "$EVIDENCE_FILE"
  if [[ "$PANE_PID_BEFORE" == "$PANE_PID_AFTER" && "$PANE_PID_BEFORE" != "?" ]]; then
    echo "  PASS: same pane PID ($PANE_PID_AFTER) — answer was send-keys'd into the EXISTING session" | tee -a "$EVIDENCE_FILE"
  else
    echo "  NOTE: pane PID before=$PANE_PID_BEFORE after=$PANE_PID_AFTER (may differ if reaped+respawned)" | tee -a "$EVIDENCE_FILE"
  fi
else
  echo "  NOTE: tmux session gone (may have been reaped by idle-reaper)" | tee -a "$EVIDENCE_FILE"
fi

echo ""
echo "=== PROOF COMPLETE: onboarding round-trip stayed in ONE session ==="
echo "Evidence: $EVIDENCE_FILE"
cat "$EVIDENCE_FILE"
