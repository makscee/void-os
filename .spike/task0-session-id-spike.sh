#!/bin/sh
# Task 0 spike: verify --session-id continuity through vc
# Run from a throwaway cwd (not the repo) to keep the CC slug isolated.
# Results logged to /tmp/void-os-spike/spike-results.txt
set -e

SCRATCH=/tmp/void-os-spike-$(date +%s)
mkdir -p "$SCRATCH"
cd "$SCRATCH"

U=$(uuidgen | tr 'A-Z' 'a-z')
echo "uuid=$U"
echo "cwd=$SCRATCH"
echo ""

echo "=== STEP 1: first turn (expect reply: ACORN) ==="
vc -- --session-id "$U" -p "Reply with the word ACORN and nothing else." --permission-mode bypassPermissions

echo ""
echo "=== STEP 2: resume (expect reply: ACORN) ==="
vc -- --resume "$U" -p "What word did I ask you to reply with?" --permission-mode bypassPermissions

echo ""
echo "=== STEP 3: session file location ==="
SLUG=$(echo "$SCRATCH" | sed 's|/|-|g' | sed 's|^-||')
SESSION_FILE="$HOME/.claude/projects/$SLUG/$U.jsonl"
if [ -f "$SESSION_FILE" ]; then
  echo "FOUND: $SESSION_FILE"
  echo "Pattern: ~/.claude/projects/<cwd-slug>/<uuid>.jsonl"
  echo "Slug rule: realpath(cwd) | strip leading / | replace / with -"
  echo "VERDICT: PRIMARY mechanic CONFIRMED"
else
  echo "NOT FOUND at $SESSION_FILE"
  echo "Searching..."
  find ~/.claude/projects -name "${U}.jsonl" 2>/dev/null || echo "not found anywhere"
fi
