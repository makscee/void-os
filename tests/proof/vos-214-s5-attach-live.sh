#!/usr/bin/env bash
# vos-214-s5-attach-live.sh — MASTER-RUN live proof for VOS-214 S5·t5 (attach lands a live pane).
# REAPER CONSTRAINT: spawns live vc --raw/claude/tmux → MUST be master-run, never a subagent.
# The implementer leaves this script written + bash -n + PROOF_DRY_RUN verified; master runs it.
#
# Exit 1 on EVERY load-bearing assertion (no WARN-and-continue).
# Asserts deterministic WIRING, not LLM-output timing.
#
# S5·t5: attach to a REAPED session lands a LIVE/resumed REPL pane (not a dead shell).
#   POST /attach-here on a reaped session → respawnSession fires → tmux session comes live.
#   The attach-here route must work even after reap: the pane must be active (not exited).
#
# USAGE: bash tests/proof/vos-214-s5-attach-live.sh <VAULT> <PORT>
#   VAULT = a fresh test vault with an interactive skill (e.g. onboarding)
#   daemon must already be serving that vault from THIS worktree's code on PORT
#
# HARD assertions (exit 1 on any miss):
#   setup: launch an interactive skill, let it run, then kill/reap its tmux session
#   t5a: POST /attach-here on the reaped session returns {ok} (the retarget signal)
#   t5b: after /attach-here, tmux vos-run-<uuid> is live (respawnSession fired via attach-here)
#   t5c: pane is active (capture-pane returns content), not an immediately-exiting dead shell
set -uo pipefail
VAULT="${1:?pass VAULT}"; PORT="${2:?pass PORT}"
BASE="http://127.0.0.1:${PORT}"; SOCK=vos
EV="/tmp/vos-214-s5-proof.txt"; : > "$EV"
say(){ echo "$@" | tee -a "$EV"; }
die(){ echo "FAIL: $*" | tee -a "$EV"; exit 1; }
pass(){ echo "PASS: $*" | tee -a "$EV"; }

say "=== VOS-214 S5·t5 attach-live proof — $(date) ==="
say "vault=$VAULT port=$PORT"

# ---- PROOF_DRY_RUN: exercise all non-live scaffolding, skip live spawn ----
if [[ "${PROOF_DRY_RUN:-}" == "1" ]]; then
  say "--- PROOF_DRY_RUN mode: exercising non-live scaffolding ---"

  [[ -n "$VAULT" ]] || die "DRY: VAULT arg missing"
  [[ -n "$PORT" ]] || die "DRY: PORT arg missing"
  pass "DRY: arg parse OK (VAULT=$VAULT PORT=$PORT)"

  # Validate Location-header parse on a canned fixture
  H=$(mktemp)
  printf 'HTTP/1.1 302 Found\r\nlocation: /s/exec-00000000-0000-0000-0000-000000000004\r\nContent-Length: 0\r\n\r\n' > "$H"
  FAKE_UUID=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}' | sed 's|^/s/||')
  [[ -n "$FAKE_UUID" ]] || die "DRY: Location-header parse failed"
  [[ "$FAKE_UUID" == exec-* ]] || die "DRY: parsed UUID does not start with exec-: $FAKE_UUID"
  rm -f "$H"
  pass "DRY: Location-header parse helper OK"

  # Validate {ok} JSON parse for attach-here response
  FAKE_RESP='{"ok":true}'
  echo "$FAKE_RESP" | grep -q '"ok"' || die "DRY: {ok} response parse failed"
  pass "DRY: {ok} response parse OK"

  # Validate tmux has-session logic (dry: just check the command exists)
  command -v tmux >/dev/null 2>&1 || die "DRY: tmux not in PATH"
  pass "DRY: tmux available"

  # Validate capture-pane active-check pattern
  FAKE_PANE="Claude is thinking about your request..."
  LINES=$(echo "$FAKE_PANE" | grep -cE '[[:alnum:]]')
  [[ "$LINES" -gt 0 ]] || die "DRY: capture-pane active-check pattern failed"
  pass "DRY: capture-pane active-check pattern OK"

  say "--- PROOF_DRY_RUN COMPLETE (all non-live assertions passed) ---"
  exit 0
fi

# ---- LIVE PROOF ----

# --- Setup: launch onboarding (interactive), wait for activity, then reap it ---
say "--- setup: launching onboarding (interactive) ---"
H=/tmp/vos214-s5-launch-$$.txt
curl -s -D "$H" -X POST "$BASE/launch" -d 'skill=onboarding' -o /dev/null
LOC=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"
[[ -n "$LOC" ]] || die "setup: /launch did not return 302 Location header"
RUNID="${LOC#/s/}"
[[ -n "$RUNID" ]] || die "setup: could not extract RUNID from Location: $LOC"
TM="vos-run-${RUNID}"
say "RUNID=$RUNID"

sleep 2
tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null || die "setup: tmux $TM not live after launch"
pass "setup: tmux $TM live"

# Wait for kickoff to reach pane (claude cold-start, up to 120s)
say "polling pane for kickoff (≤120s)..."
OK=0
for i in $(seq 1 120); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "$TM" 2>/dev/null || echo "")
  [[ $(echo "$T" | grep -cE '[[:alnum:]]') -gt 3 ]] && { OK=1; say "  pane active after ${i}s"; break; }
done
[[ "$OK" == 1 ]] || die "setup: kickoff never reached pane (idle 120s)"

# Wait for cc-actual-session.txt (needed by respawnSession for --resume)
CCID=""
for i in $(seq 1 60); do
  CCFILE=$(find "$VAULT" -path "*${RUNID}*cc-actual-session.txt" 2>/dev/null | head -1)
  if [[ -n "$CCFILE" && -s "$CCFILE" ]]; then CCID=$(tr -d '[:space:]' < "$CCFILE"); break; fi
  sleep 1
done
[[ -n "$CCID" ]] || die "setup: cc-actual-session.txt not written — respawnSession cannot resume without ccId"
pass "setup: ccId=$CCID"

# Reap the session (simulate idle-reap)
say "setup: reaping tmux session (simulate reap)..."
tmux -L "$SOCK" kill-session -t "$TM" 2>/dev/null || true
sleep 2
tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null && die "setup: tmux $TM still live after kill (reap failed)"
pass "setup: session reaped (tmux killed)"

# --- t5a: POST /attach-here on reaped session → {ok} ---
say "--- t5a: POST /attach-here on reaped session ---"
ATTACH_RESP=$(curl -s -X POST "$BASE/s/$RUNID/attach-here" 2>&1)
echo "$ATTACH_RESP" | grep -q '"ok"' || die "t5a: POST /attach-here on reaped session did not return {ok}. Got: ${ATTACH_RESP:0:200}"
pass "t5a: POST /attach-here returned {ok} on reaped session"

# --- t5b: tmux session respawned (respawnSession fired) ---
say "--- t5b: waiting for tmux $TM to respawn (≤30s) ---"
DEADLINE=$((SECONDS + 30))
until tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null; do
  [[ $SECONDS -lt $DEADLINE ]] || die "t5b: tmux $TM never respawned after /attach-here (respawnSession did not fire on reaped session)"
  sleep 1
done
pass "t5b: tmux $TM is live (respawnSession fired via /attach-here)"

# --- t5c: pane is active (not a dead/exiting shell) ---
say "--- t5c: pane activity check (not a dead shell) ---"
ACTIVE=0
for i in $(seq 1 30); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "$TM" 2>/dev/null || echo "")
  [[ $(echo "$T" | grep -cE '[[:alnum:]]') -gt 3 ]] && { ACTIVE=1; say "  resumed pane active after ${i}s"; break; }
done
[[ "$ACTIVE" == 1 ]] || die "t5c: attached pane never became active — landed a dead shell (not a live REPL)"
tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null || die "t5c: tmux session exited immediately after respawn (dead shell)"
pass "t5c: attached pane is a LIVE/resumed REPL (active content, session stays up)"

say ""
say "=== VOS-214 S5·t5 ATTACH-LIVE PROOF COMPLETE ==="
cat "$EV"
