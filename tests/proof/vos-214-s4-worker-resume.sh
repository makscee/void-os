#!/usr/bin/env bash
# vos-214-s4-worker-resume.sh — MASTER-RUN live proof for VOS-214 S4 (worker-resume invariant).
# REAPER CONSTRAINT: spawns live vc --raw/claude/tmux → MUST be master-run, never a subagent.
# The implementer leaves this script written + bash -n + PROOF_DRY_RUN verified; master runs it.
#
# Exit 1 on EVERY load-bearing assertion (no WARN-and-continue).
# Asserts deterministic WIRING, not LLM-output timing.
#
# S4·t1–t4: skill-author worker finishes/reaps; finished shell STILL renders msgForm + ccId copybtn;
#   EXEC_COUNT unchanged across POST /send (7→7 not 7→8) + same vos-run-<uuid> respawn via
#   --resume <ccId>; follow-up text in capture-pane; NO "No conversation found".
#
# This is round-trip 2 of vos-211-act-loop.sh, extended to assert the finished-shell affordances
# (t2) and the "No conversation found" absence check (t4).
#
# USAGE: bash tests/proof/vos-214-s4-worker-resume.sh <VAULT> <PORT>
#   VAULT = a fresh test vault with the skill-author skill
#   daemon must already be serving that vault from THIS worktree's code on PORT
#
# HARD assertions (exit 1 on any miss):
#   t1: cc-actual-session.txt written; /status ∈ {complete,reaped}; no live vos-run-<uuid>
#   t2: finished shell has #msgForm (input+Send) + #copybtn with ccId-form resume cmd (ungated)
#   t3: EXEC_COUNT_BEFORE==EXEC_COUNT_AFTER; same vos-run-<uuid> tmux respawns via --resume <ccId>
#   t4: follow-up text in capture-pane; pane does NOT contain "No conversation found"
set -uo pipefail
VAULT="${1:?pass VAULT}"; PORT="${2:?pass PORT}"
BASE="http://127.0.0.1:${PORT}"; SOCK=vos
EV="/tmp/vos-214-s4-proof.txt"; : > "$EV"
say(){ echo "$@" | tee -a "$EV"; }
die(){ echo "FAIL: $*" | tee -a "$EV"; exit 1; }
pass(){ echo "PASS: $*" | tee -a "$EV"; }

say "=== VOS-214 S4 worker-resume proof — $(date) ==="
say "vault=$VAULT port=$PORT"

DB="${VAULT}/.void-os/registry.db"

# ---- PROOF_DRY_RUN: exercise all non-live scaffolding, skip live spawn ----
if [[ "${PROOF_DRY_RUN:-}" == "1" ]]; then
  say "--- PROOF_DRY_RUN mode: exercising non-live scaffolding ---"

  [[ -n "$VAULT" ]] || die "DRY: VAULT arg missing"
  [[ -n "$PORT" ]] || die "DRY: PORT arg missing"
  pass "DRY: arg parse OK (VAULT=$VAULT PORT=$PORT)"

  # Validate Location-header parse on a canned fixture
  H=$(mktemp)
  printf 'HTTP/1.1 302 Found\r\nlocation: /s/exec-00000000-0000-0000-0000-000000000003\r\nContent-Length: 0\r\n\r\n' > "$H"
  FAKE_UUID=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}' | sed 's|^/s/||')
  [[ -n "$FAKE_UUID" ]] || die "DRY: Location-header parse failed"
  [[ "$FAKE_UUID" == exec-* ]] || die "DRY: parsed UUID does not start with exec-: $FAKE_UUID"
  rm -f "$H"
  pass "DRY: Location-header parse helper OK"

  # Validate sqlite3 baseline logic on a temp DB
  TMP_DB=$(mktemp /tmp/vos214-s4-dry-XXXXXX.db)
  sqlite3 "$TMP_DB" "CREATE TABLE executions (id TEXT, started_at TEXT);" 2>/dev/null || die "DRY: sqlite3 create failed"
  sqlite3 "$TMP_DB" "INSERT INTO executions VALUES ('e1','2026-01-01');" 2>/dev/null || die "DRY: sqlite3 insert failed"
  CNT=$(sqlite3 "$TMP_DB" "SELECT count(*) FROM executions;" 2>/dev/null) || die "DRY: sqlite3 count failed"
  [[ "$CNT" == "1" ]] || die "DRY: sqlite3 count mismatch (expected 1, got $CNT)"
  # Simulate post-send: count still 1
  CNT2=$(sqlite3 "$TMP_DB" "SELECT count(*) FROM executions;" 2>/dev/null) || die "DRY: sqlite3 post-send count failed"
  [[ "$CNT2" == "$CNT" ]] || die "DRY: EXEC_COUNT invariant logic broken"
  rm -f "$TMP_DB"
  pass "DRY: sqlite3 baseline+invariant logic OK"

  # Validate cc-actual find pattern
  TMP_VAULT=$(mktemp -d)
  FAKE_RUN="exec-00000000-0000-0000-0000-000000000003"
  mkdir -p "$TMP_VAULT/.void-os/sessions/$FAKE_RUN"
  echo "fakeccid-0000-0000-0000-000000000003" > "$TMP_VAULT/.void-os/sessions/$FAKE_RUN/cc-actual-session.txt"
  CC_FILE=$(find "$TMP_VAULT" -path "*${FAKE_RUN}*cc-actual-session.txt" 2>/dev/null | head -1)
  [[ -n "$CC_FILE" && -s "$CC_FILE" ]] || die "DRY: cc-actual-session.txt find pattern failed"
  pass "DRY: cc-actual-session.txt find pattern OK"
  rm -rf "$TMP_VAULT"

  # Validate "No conversation found" grep pattern
  CLEAN_PANE="Claude is thinking..."
  BAD_PANE="Error: No conversation found for session"
  echo "$CLEAN_PANE" | grep -qiE 'No conversation found|no such session|conversation .* not found' && die "DRY: false positive on clean pane"
  echo "$BAD_PANE" | grep -qiE 'No conversation found|no such session|conversation .* not found' || die "DRY: false negative — bad-pane pattern not caught"
  pass "DRY: 'No conversation found' grep pattern OK"

  say "--- PROOF_DRY_RUN COMPLETE (all non-live assertions passed) ---"
  exit 0
fi

# ---- LIVE PROOF ----

# --- Launch skill-author (non-interactive worker) ---
say "--- launching skill-author (non-interactive worker) ---"
H=/tmp/vos214-s4-launch-$$.txt
curl -s -D "$H" -X POST "$BASE/launch" -d 'skill=skill-author' -o /dev/null
LOC=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"
[[ -n "$LOC" ]] || die "launch: /launch did not return 302 Location header"
RUNID="${LOC#/s/}"
[[ -n "$RUNID" ]] || die "launch: could not extract RUNID from Location: $LOC"
TM="vos-run-${RUNID}"
say "RUNID=$RUNID"

sleep 2
tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null || die "launch: tmux $TM not live after launch"
pass "launch: tmux $TM live"

# --- t1: wait for worker to finish + reap ---
say "--- t1: waiting for worker to finish/reap (≤120s) ---"
DEADLINE=$((SECONDS + 120))
until ! tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null; do
  [[ $SECONDS -lt $DEADLINE ]] || die "t1: worker tmux session never reaped after 120s"
  sleep 2
done
pass "t1: worker tmux session reaped"

tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null && die "t1: tmux $TM still live (expected reaped)"
pass "t1: confirmed no live tmux for $RUNID"

# Check /status ∈ {complete, reaped}
STATUS=$(curl -s "$BASE/s/$RUNID/status" 2>/dev/null | tr -d '[:space:]')
[[ "$STATUS" == "complete" || "$STATUS" == "reaped" ]] || die "t1: /status=$STATUS (expected complete or reaped)"
pass "t1: /status=$STATUS (worker finished)"

# Check cc-actual-session.txt
CCID=""; CCFILE=""
for i in $(seq 1 10); do
  CCFILE=$(find "$VAULT" -path "*${RUNID}*cc-actual-session.txt" 2>/dev/null | head -1)
  if [[ -n "$CCFILE" && -s "$CCFILE" ]]; then CCID=$(tr -d '[:space:]' < "$CCFILE"); break; fi
  sleep 1
done
[[ -n "$CCID" ]] || die "t1: cc-actual-session.txt missing/empty for $RUNID — resume will be impossible (respawnSession returns null)"
pass "t1: cc-actual-session.txt written (ccId=$CCID)"

# --- t2: finished shell has #msgForm + #copybtn with ccId-form resume cmd ---
say "--- t2: checking finished shell affordances ---"
SHELL_HTML=$(curl -s "$BASE/s/$RUNID")

# #msgForm: input + Send button present (ungated even on finished session)
echo "$SHELL_HTML" | grep -qE 'id="msgForm"|id=.msgForm.' || die "t2: #msgForm absent on finished session shell"
echo "$SHELL_HTML" | grep -qE 'name="text"' || die "t2: msg-input (name=text) absent on finished session shell"
echo "$SHELL_HTML" | grep -qE 'msg-send|>Send<|value="Send"' || die "t2: Send button absent on finished session shell"
pass "t2: #msgForm (input+Send) present on finished session shell (ungated)"

# #copybtn with ccId-form resume cmd (not a tmux target, not a runId)
echo "$SHELL_HTML" | grep -qE 'id="copybtn"|data-cmd' || die "t2: #copybtn / data-cmd absent on finished session shell"
RESUMELINE=$(echo "$SHELL_HTML" | grep -oE 'vc -- --resume [0-9a-f-]+' | head -1 || true)
if [[ -n "$RESUMELINE" ]]; then
  RID=$(echo "$RESUMELINE" | awk '{print $NF}')
  [[ "$RID" == exec-* ]] && die "t2: resume command uses runId ($RID) not ccId — resume-not-found bug"
  pass "t2: #copybtn carries ccId-form resume cmd ($RESUMELINE)"
else
  # Acceptable only if data-cmd is absent (pre-ccId window); but we have ccId now so it must be there
  echo "$SHELL_HTML" | grep -q 'data-cmd' && die "t2: data-cmd present but no --resume UUID found — inspect the HTML"
  die "t2: no ccId-form resume command found on finished session shell"
fi
echo "$SHELL_HTML" | grep -qE 'tmux -L vos attach -t' && die "t2: dead 'tmux -L vos attach -t' target still present on shell"
pass "t2: no dead tmux-attach target in shell"

# --- t3: EXEC_COUNT invariant — POST /send must NOT create a new exec row ---
say "--- t3: EXEC_COUNT invariant (worker-resume, not successor-spawn) ---"
[[ -f "$DB" ]] || die "t3: registry.db not found at $DB"

# Baseline AFTER worker launch+reap (the worker's own row is legitimate)
EXEC_COUNT_BEFORE=$(sqlite3 "$DB" "SELECT count(*) FROM executions;" 2>/dev/null) || die "t3: sqlite3 baseline query failed"
pass "t3: exec count at reaped baseline (pre-/send): $EXEC_COUNT_BEFORE"

FOLLOW_PROBE="vos214s4followup$$"
SEND_RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/s/${RUNID}/send" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "answer=${FOLLOW_PROBE}" 2>&1)
HTTP_CODE=$(echo "$SEND_RESP" | tail -1)
[[ "$HTTP_CODE" -lt 400 ]] || die "t3: POST /send returned error $HTTP_CODE"
pass "t3: POST /send returned $HTTP_CODE"

# Hard-fail: exec count must be unchanged (resume, not successor-spawn)
EXEC_COUNT_AFTER=$(sqlite3 "$DB" "SELECT count(*) FROM executions;" 2>/dev/null) || die "t3: sqlite3 post-send query failed"
[[ "$EXEC_COUNT_AFTER" = "$EXEC_COUNT_BEFORE" ]] || \
  die "t3: WORKER-RESUME INVARIANT VIOLATED: exec count changed $EXEC_COUNT_BEFORE → $EXEC_COUNT_AFTER (new exec row = successor-spawn, not resume)"
pass "t3: exec count unchanged ($EXEC_COUNT_BEFORE → $EXEC_COUNT_AFTER) — no new exec row (worker-resume invariant held)"

# Same vos-run-<uuid> tmux session must respawn
DEADLINE=$((SECONDS + 15))
until tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null; do
  [[ $SECONDS -lt $DEADLINE ]] || die "t3: tmux $TM never respawned after /send (respawnSession did not fire)"
  sleep 1
done
pass "t3: tmux $TM respawned via --resume <ccId> after /send (SAME uuid, same thread)"

# --- t4: follow-up text in pane; no "No conversation found" ---
say "--- t4: follow-up text in capture-pane; no 'No conversation found' ---"
DEADLINE=$((SECONDS + 30))
FOUND=0
until tmux -L "$SOCK" capture-pane -t "$TM" -p 2>/dev/null | grep -q "$FOLLOW_PROBE"; do
  T=$(tmux -L "$SOCK" capture-pane -t "$TM" -p 2>/dev/null || echo "")
  if echo "$T" | grep -qiE 'No conversation found|no such session|conversation .* not found'; then
    echo "$T" >> "$EV"
    die "t4: pane contains 'No conversation found' — resume-not-found bug (--resume <ccId> failed)"
  fi
  [[ $SECONDS -lt $DEADLINE ]] || die "t4: follow-up text never appeared in capture-pane after 30s"
  sleep 2
done
pass "t4: follow-up text in capture-pane (follow-up landed in worker's own thread)"

tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null || die "t4: tmux session died after follow-up (resume-not-found + tmux-exit)"
T=$(tmux -L "$SOCK" capture-pane -t "$TM" -p 2>/dev/null || echo "")
echo "$T" | grep -qiE 'No conversation found|no such session' && die "t4: 'No conversation found' in pane"
pass "t4: no 'No conversation found' in pane; session live"

say ""
say "=== VOS-214 S4 WORKER-RESUME PROOF COMPLETE ==="
cat "$EV"
