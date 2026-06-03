#!/usr/bin/env bash
# vos-210-chat-first.sh — MASTER-RUN live proof for VOS-210 (chat-first view + attach-always + ccId resume).
# Reaper note: spawns live vc --raw/claude/tmux → MUST be master-run, never a subagent.
#
# USAGE: bash tests/proof/vos-210-chat-first.sh <VAULT> <PORT>
#   VAULT must carry the skill-author skill (the wedged no-html case the operator hit)
#   daemon must already be serving that vault from THIS worktree's code on PORT
#
# THE VOS-210 CLAIM: ANY session is attachable + has a chat input, even one that produced
# NO html body (skill-author). Pre-VOS-210 the view gated these on a frozen `interactive`
# flag, so a no-html session rendered a JSON-attach dead end + no input.
#
# HARD assertions (exit 1 on any miss; informational notes never gate):
#   A render: a no-real-content session's /s/<RUNID> HTML carries the message input + Send
#             + attach control UNCONDITIONALLY (the ungated affordances)
#   B render: copy-resume command is ccId-form `vc -- --resume <ccId>` (NOT a tmux target,
#             NOT the runId) — and the dead `tmux -L vos attach -t` string is absent
#   C render: NO iframe for the placeholder body (real-content-iff gate), but chat present
#   D live:   POST /s/<RUNID>/send reaches the live REPL (tmux session live, send text lands
#             in the pane) — proves the ungated input is wired to the real send path
set -uo pipefail
VAULT="${1:?pass VAULT}"; PORT="${2:?pass PORT}"
BASE="http://127.0.0.1:${PORT}"; SOCK=vos
EV="/tmp/vos-210-proof.txt"; : > "$EV"
say(){ echo "$@" | tee -a "$EV"; }
die(){ echo "FAIL: $*" | tee -a "$EV"; exit 1; }

say "=== VOS-210 chat-first proof — $(date) ==="
say "vault=$VAULT port=$PORT"

# --- spawn skill-author (the no-html wedged case) ---
H=/tmp/vos210-launch-$$.txt
curl -s -D "$H" -X POST "$BASE/launch" -d 'skill=skill-author' -o /dev/null
LOC=$(grep -i '^location:' "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"
[[ -n "$LOC" ]] || die "/launch did not redirect"
RUNID="${LOC#/s/}"; say "RUNID=$RUNID"
TM="vos-run-${RUNID}"
sleep 2
tmux -L "$SOCK" has-session -t "$TM" 2>/dev/null || die "tmux $TM not live after launch"
say "PASS: tmux $TM live"

# --- pull the rendered shell BEFORE any real content exists (placeholder body) ---
HTML=$(curl -s "$BASE/s/$RUNID")

# A: message input + Send + attach control unconditional
echo "$HTML" | grep -qE 'name="msg"|id="msg"|placeholder=' || die "A: no message input in no-html session view (input still gated)"
echo "$HTML" | grep -qiE '>Send<|value="Send"|Send</button>' || die "A: no Send control in no-html session view"
echo "$HTML" | grep -qiE 'attach-here|/attach-here|Attach' || die "A: no attach control in no-html session view (attach still gated)"
say "PASS A: no-html session renders message input + Send + attach UNCONDITIONALLY"

# B: ccId-form resume command, dead tmux target absent
if echo "$HTML" | grep -qE 'tmux -L vos attach -t'; then
  die "B: HTML still carries dead 'tmux -L vos attach -t' target (the not-found resume command)"
fi
# the resume command must reference --resume with a UUID (ccId), not the exec- runId
RESUMELINE=$(echo "$HTML" | grep -oE 'vc -- --resume [0-9a-f-]+' | head -1 || true)
if [[ -n "$RESUMELINE" ]]; then
  RID=$(echo "$RESUMELINE" | awk '{print $NF}')
  [[ "$RID" == exec-* ]] && die "B: resume command uses runId ($RID) not ccId"
  say "PASS B: resume command is ccId-form ($RESUMELINE), no dead tmux target"
else
  # acceptable only if no ccId exists yet AND no bogus resume command is shown
  echo "$HTML" | grep -qE 'vc -- --resume exec-|tmux .* attach' && die "B: bogus resume command shown before ccId exists"
  say "PASS B: no dead/bogus resume command shown before ccId exists (no tmux target)"
fi

# C: no iframe for placeholder, but chat present
if echo "$HTML" | grep -qE '<iframe'; then
  # iframe is only allowed if body.html already has real content; check the placeholder signature
  BODY=$(find "$VAULT" -path "*${RUNID}*body.html" 2>/dev/null | head -1)
  if [[ -n "$BODY" ]] && grep -qE 'class="spinner"|— starting…|starting\.\.\.' "$BODY" 2>/dev/null; then
    die "C: iframe rendered while body.html is still the placeholder (real-content-iff gate broken)"
  fi
  say "note C: iframe present — body.html already has real content (acceptable)"
else
  say "PASS C: no iframe for placeholder body (real-content-iff), chat affordances still present"
fi

# --- D: ungated input on an INTERACTIVE session reaches the live REPL ---
# Scope note: the live send loop VOS-210 ungated is the INTERACTIVE path (chat/onboarding).
# A WORKER skill's /send spawns a successor (thread-resume of a worker = VOS-211 unified-send
# scope), so D launches onboarding (interactive) — the path the ungated input actually drives.
say "launching onboarding (interactive) for D..."
HD=/tmp/vos210-launchD-$$.txt
curl -s -D "$HD" -X POST "$BASE/launch" -d 'skill=onboarding' -o /dev/null
DLOC=$(grep -i '^location:' "$HD" | tr -d '\r' | awk '{print $2}'); rm -f "$HD"
DRUN="${DLOC#/s/}"; DTM="vos-run-${DRUN}"; say "  D RUNID=$DRUN"
sleep 2
tmux -L "$SOCK" has-session -t "$DTM" 2>/dev/null || die "D: onboarding tmux not live"
curl -s "$BASE/s/$DRUN" | grep -qE 'name="msg"|id="msg"|placeholder=' || die "D: interactive session view missing the ungated message input"
say "polling onboarding pane for kickoff (<=120s)..."
OK=0
for i in $(seq 1 120); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "$DTM" 2>/dev/null || echo "")
  [[ $(echo "$T" | grep -cE '[[:alnum:]]') -gt 3 ]] && { OK=1; say "  pane active after ${i}s"; break; }
done
[[ "$OK" == 1 ]] || die "D: kickoff never reached pane (idle 120s)"

MARK="VOS210PROBE$$"
say "POST /s/$DRUN/send msg=$MARK (ungated input → live REPL via send-keys)"
curl -s -X POST "$BASE/s/$DRUN/send" -d "msg=${MARK}" -o /dev/null
LANDED=0
for i in $(seq 1 30); do
  sleep 1
  T=$(tmux -L "$SOCK" capture-pane -p -t "$DTM" 2>/dev/null || echo "")
  echo "$T" | grep -q "$MARK" && { LANDED=1; say "  probe landed in pane after ${i}s"; break; }
done
[[ "$LANDED" == 1 ]] || die "D: sent message never reached the interactive REPL pane (ungated input not wired to send path)"
tmux -L "$SOCK" has-session -t "$DTM" 2>/dev/null || die "D: tmux session died after send"
say "PASS D: ungated input → /send → live INTERACTIVE REPL (probe in pane, session live)"
say "note D: WORKER-skill thread-resume (/send on interactive:false spawns a successor) is VOS-211 unified-send scope, intentionally out of VOS-210/212."

say ""
say "=== VOS-210 PROOF COMPLETE — chat-first affordances ungated + wired live ==="
cat "$EV"
