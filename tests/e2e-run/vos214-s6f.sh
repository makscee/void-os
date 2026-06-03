#!/usr/bin/env bash
# VOS-214 Phase 4 — S6 fixture runner.
# Boots the vos214-s6f-serve.ts harness, parses the READY line, exports env vars,
# runs Playwright, tears down.
#
# Usage: cd ~/void-os-wt/VOS-214-s6f && bash tests/e2e-run/vos214-s6f.sh
# Expected: 2 passed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

EVIDENCE="${HOME}/hub/vault/work/evidence/VOS-214/s6"
mkdir -p "$EVIDENCE"

TRUTH_OUT="${EVIDENCE}/s6f-truth.json"

# Boot the harness in background; redirect stderr to /dev/null to suppress bun noise
SERVE_LOG=$(mktemp)
bun run "${REPO_ROOT}/.e2e/vos214-s6f-serve.ts" > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!

cleanup() {
  kill "$SERVE_PID" 2>/dev/null || true
  rm -f "$SERVE_LOG"
}
trap cleanup EXIT

# Wait for READY line (up to 10s)
READY_URL=""
SESSION_ID=""
for i in $(seq 1 50); do
  if grep -q "^READY " "$SERVE_LOG" 2>/dev/null; then
    READY_URL=$(grep "^READY " "$SERVE_LOG" | head -1 | awk '{print $2}')
    SESSION_ID=$(grep "^SESSION=" "$SERVE_LOG" | head -1 | cut -d= -f2)
    break
  fi
  sleep 0.2
done

if [ -z "$READY_URL" ]; then
  echo "ERROR: serve harness did not print READY within 10s"
  cat "$SERVE_LOG"
  exit 1
fi

echo "Harness ready at: ${READY_URL}"
echo "Session: ${SESSION_ID}"

export VOS214_S6F_BASE_URL="$READY_URL"
export VOS214_S6F_SESSION="$SESSION_ID"
export VOS214_S6F_TRUTH_OUT="$TRUTH_OUT"
export VOS214_S6F_SHOT_DIR="$EVIDENCE"

# Run Playwright
cd "$REPO_ROOT"
bunx playwright test --config .e2e/playwright.vos214-s6f.config.ts

EXIT_CODE=$?
echo ""
echo "Truth output: $TRUTH_OUT"
if [ -f "$TRUTH_OUT" ]; then
  cat "$TRUTH_OUT"
fi

exit $EXIT_CODE
