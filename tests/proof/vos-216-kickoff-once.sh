#!/usr/bin/env bash
# vos-216-kickoff-once.sh — Real-path proof: sendKickoff delivers kickoff EXACTLY ONCE.
#
# Strategy: spawn a controlled tmux session that simulates the REPL idle state (shows ❯
# and a footer marker in its status), then call sendKickoff() via bun and verify it sent
# the skill line exactly once (not 4×).
#
# The simulation:
#   1. Start a tmux session on the vos socket running a script that:
#      - Prints an idle-ready pane (❯ + "bypass permissions" footer)
#      - Waits for the skill line to arrive in a temp file (sent via send-keys)
#      - Records each received line to an output file
#   2. Run sendKickoff() via bun (against the real sendKickoffWith implementation)
#   3. Assert that exactly ONE send was made (transcript has 1 kickoff line)
#
# This proves: after VOS-216, the idle spinner chars no longer cause false-positive
# acceptance, and the baseline-change detector correctly identifies the real send.
#
# HARD FAIL on every load-bearing assertion (exit 1 on miss).
set -uo pipefail

PROOF_OUT="/tmp/vos-216-kickoff-once-proof-$$.txt"
: > "$PROOF_OUT"
say() { echo "$@" | tee -a "$PROOF_OUT"; }
die() { echo "FAIL: $*" | tee -a "$PROOF_OUT"; exit 1; }
pass() { echo "PASS: $*" | tee -a "$PROOF_OUT"; }

WDIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
SOCK=vos
SESSION="vos-216-proof-$$"
INPUT_FILE="/tmp/vos216-input-$$.txt"
SEND_LOG="/tmp/vos216-sends-$$.txt"
: > "$INPUT_FILE"
: > "$SEND_LOG"

say "=== VOS-216 kickoff-once proof — $(date) ==="
say "worktree=$WDIR session=$SESSION"

cleanup() {
  tmux -L "$SOCK" kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$INPUT_FILE" "$SEND_LOG"
}
trap cleanup EXIT

# ── 1. Start controlled tmux session ──
# The session runs a bash script that:
#   - Shows the idle-ready pane content (❯ + bypass permissions) so waitForReady detects it
#   - Reads lines from tmux send-keys and logs them to SEND_LOG
#   - ALSO prints the "Esc to interrupt" acceptance signal after receiving the kickoff
SHELL_SCRIPT=$(cat << 'SCRIPTEOF'
#!/usr/bin/env bash
# Simulate REPL idle state visible in tmux pane
# The pane content (visible via capture-pane -p) is the terminal output
printf '\033[2J\033[H'
echo "❯"
echo "bypass permissions on (shift+tab to cycle) · ← for agents"
# Enter read loop — lines sent via send-keys land on stdin
while IFS= read -r line; do
  echo "$line" >> __SEND_LOG__
  # Simulate "Esc to interrupt" appearing after receiving input
  echo "Esc to interrupt"
  echo "❯"
  echo "bypass permissions on (shift+tab to cycle) · ← for agents"
done
SCRIPTEOF
)
SHELL_SCRIPT="${SHELL_SCRIPT//__SEND_LOG__/$SEND_LOG}"

# Write the script to a temp file
CTRL_SCRIPT="/tmp/vos216-ctrl-$$.sh"
echo "$SHELL_SCRIPT" > "$CTRL_SCRIPT"
chmod +x "$CTRL_SCRIPT"

tmux -L "$SOCK" new-session -d -s "$SESSION" -c /tmp "bash $CTRL_SCRIPT" 2>/dev/null \
  || die "Failed to start tmux session $SESSION"
say "Started tmux session $SESSION"

sleep 0.5

# Verify session is up and shows the expected idle pane
PANE=$(tmux -L "$SOCK" capture-pane -p -t "$SESSION" 2>/dev/null)
echo "$PANE" | grep -q "❯" || die "Session pane does not show ❯ — simulation not running"
echo "$PANE" | grep -q "bypass permissions" || die "Session pane missing footer marker"
pass "Session pane shows idle-ready state (❯ + footer)"

# ── 2. Run sendKickoff via bun ──
say "--- Running sendKickoff against live session ---"

KICKOFF_RESULT=$(bun --cwd "$WDIR" --eval "
import { sendKickoff } from './src/tmux.ts';

const result = await sendKickoff('$SESSION', '/onboarding', {
  maxAttempts: 6,
  acceptWaitMs: 5_000,
  acceptPollMs: 500,
});
console.log('attempts=' + result);
" 2>&1)
say "sendKickoff result: $KICKOFF_RESULT"

# Extract attempt count
ATTEMPTS=$(echo "$KICKOFF_RESULT" | grep 'attempts=' | sed 's/.*attempts=//')

# ── 3. Assert exactly ONE send ──
say "--- Asserting exactly one kickoff send ---"

# Give send-keys a moment to land
sleep 0.5

# Count lines in SEND_LOG (each send-keys that reached stdin = one line)
if [[ -f "$SEND_LOG" ]]; then
  SENDS=$(grep -c '/onboarding' "$SEND_LOG" 2>/dev/null || echo 0)
else
  SENDS=0
fi
say "Lines received in session (from send-keys): $SENDS"
say "sendKickoff reported attempts: $ATTEMPTS"

[[ "$SENDS" -eq 1 ]] || die "Expected exactly 1 kickoff send, got $SENDS (over-queue bug present)"
pass "Kickoff delivered exactly ONCE (sends=$SENDS)"

[[ "$ATTEMPTS" == "1" ]] || die "sendKickoff reported $ATTEMPTS attempts (expected 1)"
pass "sendKickoff returned attempt=1 (accepted on first try)"

# ── 4. Verify wiring: acceptance was NOT triggered by spinner chars ──
say "--- Verifying wiring: spinner chars do NOT trigger false acceptance ---"

# Run a separate invocation against a pane that has spinner chars but no "Esc to interrupt"
SESSION2="vos-216-proof-spin-$$"
SEND_LOG2="/tmp/vos216-sends2-$$.txt"
: > "$SEND_LOG2"

cleanup2() {
  tmux -L "$SOCK" kill-session -t "$SESSION2" 2>/dev/null || true
  rm -f "$SEND_LOG2" "/tmp/vos216-spin-$$.sh"
}
trap "cleanup; cleanup2" EXIT

# Spinner-only simulation: shows ❯ + spinner in status but never "Esc to interrupt",
# and does NOT echo sent text (simulates REPL pane that stays visually the same).
# Uses a static pane — the session ignores stdin and just keeps showing the idle state.
# send-keys go into the pane but the shell is sleeping (not reading stdin), so the
# pane content only changes via the spinner animation — not from actual command output.
SPIN_SCRIPT=$(cat << 'SPINEOF'
#!/usr/bin/env bash
printf '\033[2J\033[H'
echo "❯"
echo "Relay: ⠋ 0tk bypass permissions on · ← for agents"
# Just sleep — don't read stdin or echo anything
# This simulates a REPL that accepted send-keys without showing "Esc to interrupt" yet
sleep 300
SPINEOF
)
echo "$SPIN_SCRIPT" > "/tmp/vos216-spin-$$.sh"
chmod +x "/tmp/vos216-spin-$$.sh"

tmux -L "$SOCK" new-session -d -s "$SESSION2" -c /tmp "bash /tmp/vos216-spin-$$.sh" 2>/dev/null \
  || die "Failed to start spinner session $SESSION2"

# Record what gets sent to the spinner session by intercepting via send-keys wrapper in bun
sleep 0.5

PANE2=$(tmux -L "$SOCK" capture-pane -p -t "$SESSION2" 2>/dev/null)
say "Spinner session pane: $(echo "$PANE2" | head -3 | tr '\n' '|')"

# Use the injectable sendKickoffWith to precisely control what the mock pane returns
# and count how many times sendFn is called
SPIN_RESULT=$(bun --cwd "$WDIR" --eval "
import { sendKickoffWith } from './src/tmux.ts';

// Simulate idle pane with spinner chars — ALWAYS returns the same spinner content
// This reproduces the bug environment: pane has ⠋ at idle, never shows 'Esc to interrupt'
const baseline = '❯\nRelay: ⠋ 0tk bypass permissions on · ← for agents\n';
const idlePaneWithDifferentSpinner = '❯\nRelay: ⠙ 0tk bypass permissions on · ← for agents\n';

let captureCount = 0;
// Return baseline for first call, then a slightly different pane (spinner advanced)
// but still NO acceptance signal
const mockCapture = (_t) => {
  captureCount++;
  // Alternate between ⠋ and ⠙ to simulate status-bar animation
  return captureCount % 2 === 0 ? idlePaneWithDifferentSpinner : baseline;
};

let sendCount = 0;
const mockSend = (_t, line) => { sendCount++; };

const result = await sendKickoffWith(mockCapture, mockSend, 'test', '/onboarding', {
  maxAttempts: 2,
  acceptWaitMs: 500,
  acceptPollMs: 250,
  baselinePane: baseline,
});
console.log('spin-attempts=' + result);
console.log('spin-sends=' + sendCount);
" 2>&1)
say "Spinner test result: $SPIN_RESULT"
SPIN_ATTEMPTS=$(echo "$SPIN_RESULT" | grep 'spin-attempts=' | sed 's/.*spin-attempts=//')
SPIN_SENDS=$(echo "$SPIN_RESULT" | grep 'spin-sends=' | sed 's/.*spin-sends=//')

# Should have exhausted maxAttempts=2 (not returned early on spinners)
[[ "$SPIN_ATTEMPTS" == "2" ]] || die "Spinner-only pane returned attempts=$SPIN_ATTEMPTS (expected 2 — not early-exiting on spinners)"
pass "Spinner chars do NOT trigger false-positive acceptance (attempts=$SPIN_ATTEMPTS = maxAttempts)"

[[ "$SPIN_SENDS" == "2" ]] || die "Expected 2 sends to spinner session (maxAttempts), got $SPIN_SENDS"
pass "Exactly maxAttempts sends when pane never shows acceptance"

say ""
say "=== VOS-216 PROOF COMPLETE — kickoff fires exactly once, spinners don't trigger ==="
cat "$PROOF_OUT"
