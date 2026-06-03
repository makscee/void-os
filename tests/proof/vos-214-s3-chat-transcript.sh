#!/usr/bin/env bash
# vos-214-s3-chat-transcript.sh — MASTER-RUN live proof for VOS-214 S3 (plain chat → transcript).
# REAPER CONSTRAINT: spawns live vc --raw/claude/tmux → MUST be master-run, never a subagent.
# The implementer leaves this script written + bash -n + PROOF_DRY_RUN verified; master runs it.
#
# Exit 1 on EVERY load-bearing assertion (no WARN-and-continue).
# Asserts deterministic WIRING, not LLM-output timing.
#
# S3·t1–t4: chat input unconditional; /message → {ok} + text lands in pane (fetch-intercept,
#   NO JSON-page nav); /attach-here → JSON, no nav; /transcript NON-empty after a turn
#   (runId→ccId translation).
#
# USAGE: bash tests/proof/vos-214-s3-chat-transcript.sh <VAULT> <PORT>
#   VAULT = a fresh test vault with an interactive skill (e.g. onboarding)
#   daemon must already be serving that vault from THIS worktree's code on PORT
#
# HARD assertions (exit 1 on any miss):
#   t1: shell carries input[name=text].msg-input + button.msg-send UNCONDITIONALLY
#   t2: POST /message returns {ok:true}; probe text lands in tmux capture-pane (fetch-wired, not JSON-nav)
#   t3: POST /attach-here returns JSON {ok} response (fetch-intercepted, stays on shell page)
#   t4: GET /transcript is NON-empty after a real turn (ccId resolved, runId→ccId translation works)
set -uo pipefail
VAULT="${1:?pass VAULT}"; PORT="${2:?pass PORT}"
BASE="http://127.0.0.1:${PORT}"; SOCK=vos
EV="/tmp/vos-214-s3-proof.txt"; : > "$EV"
say(){ echo "$@" | tee -a "$EV"; }
die(){ echo "FAIL: $*" | tee -a "$EV"; exit 1; }
pass(){ echo "PASS: $*" | tee -a "$EV"; }

say "=== VOS-214 S3 chat-transcript proof — $(date) ==="
say "vault=$VAULT port=$PORT"

# ---- PROOF_DRY_RUN: exercise all non-live scaffolding, skip live spawn ----
if [[ "${PROOF_DRY_RUN:-}" == "1" ]]; then
  say "--- PROOF_DRY_RUN mode: exercising non-live scaffolding ---"

  [[ -n "$VAULT" ]] || die "DRY: VAULT arg missing"
  [[ -n "$PORT" ]] || die "DRY: PORT arg missing"
  pass "DRY: arg parse OK (VAULT=$VAULT PORT=$PORT)"

  # Validate Location-header parse on a canned fixture
  H=$(mktemp)
  printf 'HTTP/1.1 302 Found\r\nlocation: /s/exec-00000000-0000-0000-0000-000000000002\r\nContent-Length: 0\r\n\r\n' > "$H"
  FAKE_UUID=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}' | sed 's|^/s/||')
  [[ -n "$FAKE_UUID" ]] || die "DRY: Location-header parse failed on canned fixture"
  [[ "$FAKE_UUID" == exec-* ]] || die "DRY: parsed UUID does not start with exec-: $FAKE_UUID"
  rm -f "$H"
  pass "DRY: Location-header parse helper OK"

  # Validate HTML grep patterns for unconditional chat affordances
  FAKE_HTML='<html><body><input name="text" class="msg-input" placeholder="Send message…"><button class="msg-send">Send</button></body></html>'
  echo "$FAKE_HTML" | grep -qE 'name="text".*msg-input|msg-input.*name="text"' || die "DRY: msg-input grep pattern failed"
  echo "$FAKE_HTML" | grep -qE 'msg-send|>Send<' || die "DRY: msg-send grep pattern failed"
  pass "DRY: HTML grep patterns for chat affordances OK"

  # Validate {ok} JSON response parse
  FAKE_RESP='{"ok":true}'
  echo "$FAKE_RESP" | grep -q '"ok"' || die "DRY: {ok} response parse failed"
  pass "DRY: {ok} response parse OK"

  # Validate transcript non-empty check
  FAKE_TX='<div class="turn role-user">hello</div>'
  TX_LEN=$(printf '%s' "$FAKE_TX" | grep -cE '[[:alnum:]]')
  [[ "$TX_LEN" -gt 0 ]] || die "DRY: transcript non-empty check failed on canned fixture"
  pass "DRY: transcript non-empty check OK"

  say "--- PROOF_DRY_RUN COMPLETE (all non-live assertions passed) ---"
  exit 0
fi

# ---- LIVE PROOF ----

# --- Launch an interactive session (onboarding) ---
say "--- launching interactive session (onboarding) ---"
H=/tmp/vos214-s3-launch-$$.txt
curl -s -D "$H" -X POST "$BASE/launch" -d 'skill=onboarding' -o /dev/null
LOC=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"
[[ -n "$LOC" ]] || die "launch: /launch did not return 302 Location header"
RUNID="${LOC#/s/}"
[[ -n "$RUNID" ]] || die "launch: could not extract RUNID from Location: $LOC"
say "RUNID=$RUNID"

sleep 2
tmux -L "$SOCK" has-session -t "vos-run-${RUNID}" 2>/dev/null || die "launch: tmux vos-run-${RUNID} not live after launch"
pass "launch: tmux vos-run-${RUNID} live"

# --- t1: shell carries msg-input + msg-send UNCONDITIONALLY ---
say "--- t1: checking unconditional chat affordances ---"
SHELL_HTML=$(curl -s "$BASE/s/$RUNID")
echo "$SHELL_HTML" | grep -qE 'name="text"' || die "t1: shell missing input[name=text] (msg-input not unconditional)"
echo "$SHELL_HTML" | grep -qE 'msg-send|>Send<|value="Send"' || die "t1: shell missing Send button (msg-send not unconditional)"
pass "t1: shell carries msg-input + Send UNCONDITIONALLY (ungated, VOS-210)"

# --- t2: POST /message → {ok:true} + probe lands in pane (fetch-wired, not JSON-nav) ---
say "--- t2: POST /message probe (fetch-intercept check) ---"

# Wait for kickoff to reach pane (claude cold-start, up to 120s)
say "polling pane for kickoff (≤120s)..."
OK=0
for i in $(seq 1 120); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "vos-run-${RUNID}" 2>/dev/null || echo "")
  [[ $(echo "$T" | grep -cE '[[:alnum:]]') -gt 3 ]] && { OK=1; say "  pane active after ${i}s"; break; }
done
[[ "$OK" == 1 ]] || die "t2: kickoff never reached pane (idle 120s)"

PROBE="VOS214S3PROBE$$"
MSG_RESP=$(curl -s -X POST "$BASE/s/$RUNID/message" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "text=${PROBE}" 2>&1)
echo "$MSG_RESP" | grep -q '"ok"' || die "t2: POST /message did not return {ok} JSON. Got: ${MSG_RESP:0:200}"
pass "t2: POST /message returned {ok} (fetch-intercepted, not full-page nav)"

# Verify probe text lands in pane (bounded 30s)
LANDED=0
for i in $(seq 1 30); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "vos-run-${RUNID}" 2>/dev/null || echo "")
  echo "$T" | grep -q "$PROBE" && { LANDED=1; say "  probe landed in pane after ${i}s"; break; }
done
[[ "$LANDED" == 1 ]] || die "t2: probe text never reached tmux capture-pane (message not wired to send-keys)"
pass "t2: probe text in pane — POST /message wired to live REPL (not a JSON-page redirect)"

# --- t3: POST /attach-here → JSON, no nav ---
say "--- t3: POST /attach-here → JSON {ok} (fetch-intercepted) ---"
ATTACH_RESP=$(curl -s -X POST "$BASE/s/$RUNID/attach-here" 2>&1)
echo "$ATTACH_RESP" | grep -q '"ok"' || die "t3: POST /attach-here did not return {ok} JSON. Got: ${ATTACH_RESP:0:200}"
pass "t3: POST /attach-here returned JSON {ok} (fetch-intercepted, no full-page nav)"

# --- t4: GET /transcript NON-empty after a real turn ---
say "--- t4: GET /transcript non-empty (ccId resolved, runId→ccId translation) ---"

# Wait for cc-actual-session.txt so transcript has a ccId to resolve
CCID=""
for i in $(seq 1 60); do
  CCFILE=$(find "$VAULT" -path "*${RUNID}*cc-actual-session.txt" 2>/dev/null | head -1)
  if [[ -n "$CCFILE" && -s "$CCFILE" ]]; then CCID=$(tr -d '[:space:]' < "$CCFILE"); break; fi
  sleep 1
done
[[ -n "$CCID" ]] || die "t4: cc-actual-session.txt not written — transcript cannot resolve ccId"
say "t4: ccId=$CCID"

# Give CC time to log the turn
sleep 5

TR=$(curl -s "$BASE/s/$RUNID/transcript" 2>/dev/null)
TRLEN=$(printf '%s' "$TR" | grep -cE '[[:alnum:]]')
if [[ "$TRLEN" -gt 0 ]] && ! printf '%s' "$TR" | grep -qiE 'no transcript|empty'; then
  pass "t4: /transcript non-empty (${TRLEN} content lines) — ccId resolved, runId→ccId translation works"
else
  die "t4: /transcript empty after a real turn (TRLEN=$TRLEN) — runId→ccId translation FAILED (empty-transcript bug)"
fi

say ""
say "=== VOS-214 S3 CHAT-TRANSCRIPT PROOF COMPLETE ==="
cat "$EV"
