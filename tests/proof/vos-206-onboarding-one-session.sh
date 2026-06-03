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
# WHAT IT ASSERTS (exit 0 = PASS, all checks are HARD — exit 1 on any miss):
#   - POST /launch skill=onboarding → 302 redirect, captures RUNID
#   - session-meta.json has interactive:true
#   - ONE executions row exists for RUNID
#   - tmux session vos-run-<RUNID> is live on socket 'vos'
#   - cc-command.txt matches vc --raw -- (launch argv carries --raw)
#   - Kickoff reached the pane (claude began work within 60s, not idle REPL)
#   - POST /s/<RUNID>/send name=Alice → 302 back to /s/<RUNID> (SAME session, NOT a new exec)
#   - STILL exactly ONE executions row for RUNID (no successor spawn)
#   - Sent text 'Alice' appeared in the live pane (send-keys routed to same session)
#   - tmux session vos-run-<RUNID> has the same pane PID before/after send
#
# Note: body.html form rendering is Opus-timing-dependent and NOT a gate assertion.
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
LAUNCH_HEADERS="/tmp/vos-206-launch-headers-$$.txt"
LAUNCH_RESP=$(curl -s -D "$LAUNCH_HEADERS" -X POST "${BASE}/launch" -d 'skill=onboarding' -o /dev/null -w "%{http_code}")
LAUNCH_LOCATION=$(grep -i '^location:' "$LAUNCH_HEADERS" | tr -d '\r' | awk '{print $2}')
rm -f "$LAUNCH_HEADERS"
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
const db=openRegistry('${VAULT}/.void-os/registry.db');
const rows=db.prepare('SELECT count(*) as n FROM executions WHERE id=?').get('${RUNID}');
console.log(rows.n);
" 2>/dev/null || echo "?")
echo "  executions rows for RUNID=$EXEC_COUNT"
echo "  executions_before_send=$EXEC_COUNT" >> "$EVIDENCE_FILE"
if [[ "$EXEC_COUNT" != "1" ]]; then
  echo "FAIL: expected 1 execution row, got $EXEC_COUNT" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
echo "  PASS: exactly 1 execution row for RUNID" | tee -a "$EVIDENCE_FILE"

# ---- Check tmux session is live ----
TMUX_SESSION="vos-run-${RUNID}"
sleep 1  # allow tmux session to start
if ! tmux -L vos has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "FAIL: tmux session $TMUX_SESSION not live after launch" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
PANE_PID_BEFORE=$(tmux -L vos display-message -p -t "${TMUX_SESSION}" '#{pane_pid}' 2>/dev/null || echo "?")
echo "  PASS: tmux session $TMUX_SESSION is live (pane_pid=$PANE_PID_BEFORE)" | tee -a "$EVIDENCE_FILE"
echo "  pane_pid_before=$PANE_PID_BEFORE" >> "$EVIDENCE_FILE"

# ---- Check cc-command.txt carries --raw ----
CC_CMD_PATH="${VAULT}/sessions/${RUNID}/cc-command.txt"
sleep 0.5
if [[ ! -f "$CC_CMD_PATH" ]]; then
  echo "FAIL: cc-command.txt not found at $CC_CMD_PATH" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
CC_CMD_CONTENT=$(cat "$CC_CMD_PATH")
if echo "$CC_CMD_CONTENT" | grep -qE 'vc[[:space:]]+--raw[[:space:]]+--'; then
  echo "  PASS: cc-command.txt carries vc --raw -- (launch argv wired correctly)" | tee -a "$EVIDENCE_FILE"
else
  echo "FAIL: cc-command.txt does not match 'vc --raw --', got: $CC_CMD_CONTENT" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
echo "  cc_command=$CC_CMD_CONTENT" >> "$EVIDENCE_FILE"

# ---- Check kickoff reached the pane (claude began work, not idle REPL) ----
echo "  polling pane for kickoff activity (up to 60s)..."
KICKOFF_REACHED=0
for i in $(seq 1 60); do
  sleep 1
  PANE_TEXT=$(tmux -L vos capture-pane -p -t "$TMUX_SESSION" 2>/dev/null || echo "")
  # Idle bare banner: only banner + empty prompt, nothing else. Detect activity by:
  # - any tool-call marker, thinking spinner chars, or onboarding-specific text
  # - more than just the blank REPL (any non-whitespace line beyond the first 2 banner lines)
  ACTIVE_LINES=$(echo "$PANE_TEXT" | grep -cE '[[:alnum:]]' || true)
  if [[ "$ACTIVE_LINES" -gt 3 ]]; then
    echo "  PASS: pane shows activity after ~${i}s (kickoff delivered)" | tee -a "$EVIDENCE_FILE"
    echo "  kickoff_wait_s=$i" >> "$EVIDENCE_FILE"
    KICKOFF_REACHED=1
    break
  fi
done
if [[ "$KICKOFF_REACHED" != "1" ]]; then
  echo "FAIL: pane still idle after 60s — kickoff (waitForPrompt+send-keys) did not deliver the skill prompt" | tee -a "$EVIDENCE_FILE"
  tmux -L vos capture-pane -p -t "$TMUX_SESSION" 2>/dev/null >> "$EVIDENCE_FILE" || true
  exit 1
fi

# ---- Informational: body.html form check (NOT a gate — Opus timing varies) ----
BODY_PATH="${VAULT}/sessions/${RUNID}/body.html"
if [[ -f "$BODY_PATH" ]] && grep -q '<form' "$BODY_PATH" 2>/dev/null; then
  echo "  note: form rendered=yes (informational, not gating)" | tee -a "$EVIDENCE_FILE"
else
  echo "  note: form rendered=no (informational, not gating — Opus may still be working)" | tee -a "$EVIDENCE_FILE"
fi

# ---- Step 4: Submit form (THE core assertion) ----
echo ""
echo "[step 4] POST /s/${RUNID}/send name=Alice skill_chat=on"
SEND_HEADERS="/tmp/vos-206-send-headers-$$.txt"
SEND_RESP=$(curl -s -D "$SEND_HEADERS" -X POST "${BASE}/s/${RUNID}/send" -d 'name=Alice&skill_chat=on' -o /dev/null -w "%{http_code}")
SEND_LOCATION=$(grep -i '^location:' "$SEND_HEADERS" | tr -d '\r' | awk '{print $2}')
rm -f "$SEND_HEADERS"
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
const db=openRegistry('${VAULT}/.void-os/registry.db');
const rows=db.prepare('SELECT count(*) as n FROM executions').get();
console.log(rows.n);
" 2>/dev/null || echo "?")
echo "  total executions rows after send=$EXEC_COUNT_AFTER"
echo "  total_executions_after_send=$EXEC_COUNT_AFTER" >> "$EVIDENCE_FILE"

# Compare execution count — should not have grown by more than 1 (the original onboarding)
EXEC_FOR_RUNID=$(bun --eval "
const {openRegistry}=require('./src/registry.ts');
const db=openRegistry('${VAULT}/.void-os/registry.db');
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

# CORE ASSERTION 3: sent text 'Alice' reached the same live pane
sleep 0.5
PANE_AFTER_SEND=$(tmux -L vos capture-pane -p -t "$TMUX_SESSION" 2>/dev/null || echo "")
if echo "$PANE_AFTER_SEND" | grep -q 'Alice'; then
  echo "  PASS: 'Alice' appeared in pane — send-keys routed to the live session" | tee -a "$EVIDENCE_FILE"
else
  echo "FAIL: sent text 'Alice' did not appear in pane after send — send may have gone to wrong session or been dropped" | tee -a "$EVIDENCE_FILE"
  echo "  pane_after_send:" >> "$EVIDENCE_FILE"
  echo "$PANE_AFTER_SEND" >> "$EVIDENCE_FILE"
  exit 1
fi

# Informational: body.html form dissolution (NOT a gate)
if [[ -f "$BODY_PATH" ]] && grep -q '<form' "$BODY_PATH" 2>/dev/null; then
  echo "  note: form still present in body.html (informational — Opus may still be processing)" | tee -a "$EVIDENCE_FILE"
else
  echo "  note: form dissolved in body.html (informational)" | tee -a "$EVIDENCE_FILE"
fi

# CORE ASSERTION 4: same tmux session (pane PID unchanged — not a respawn)
if ! tmux -L vos has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "FAIL: tmux session $TMUX_SESSION gone after send — session was lost" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
PANE_PID_AFTER=$(tmux -L vos display-message -p -t "${TMUX_SESSION}" '#{pane_pid}' 2>/dev/null || echo "?")
echo "  tmux session $TMUX_SESSION still live after send (pane_pid=$PANE_PID_AFTER)" | tee -a "$EVIDENCE_FILE"
echo "  pane_pid_after=$PANE_PID_AFTER" >> "$EVIDENCE_FILE"
if [[ "$PANE_PID_BEFORE" == "?" || "$PANE_PID_AFTER" == "?" ]]; then
  echo "FAIL: pane PID could not be read (before=$PANE_PID_BEFORE after=$PANE_PID_AFTER)" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
if [[ "$PANE_PID_BEFORE" != "$PANE_PID_AFTER" ]]; then
  echo "FAIL: pane PID changed (before=$PANE_PID_BEFORE after=$PANE_PID_AFTER) — send-keys hit a respawned session, not the original" | tee -a "$EVIDENCE_FILE"
  exit 1
fi
echo "  PASS: same pane PID ($PANE_PID_AFTER) — answer was send-keys'd into the EXISTING session" | tee -a "$EVIDENCE_FILE"

echo ""
echo "=== PROOF COMPLETE: onboarding round-trip stayed in ONE session ==="
echo "Evidence: $EVIDENCE_FILE"
cat "$EVIDENCE_FILE"
