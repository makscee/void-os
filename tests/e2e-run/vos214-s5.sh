#!/usr/bin/env bash
# VOS-214 Phase-3 runner — S5 attach/resume-command fixture suite.
# Usage: bash tests/e2e-run/vos214-s5.sh
# Starts vos214-s5-serve.ts, parses READY line, sets env, runs Playwright, tears down.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHOT_DIR="${VOS214_S5_SHOT_DIR:-$HOME/hub/vault/work/evidence/VOS-214/s5}"
TRUTH_OUT="${VOS214_S5_TRUTH_OUT:-/tmp/vos214-s5-truth.json}"
LOG_FILE="/tmp/vos214-s5-serve.log"

mkdir -p "$SHOT_DIR"

# Start server
cd "$REPO_ROOT"
bun .e2e/vos214-s5-serve.ts >"$LOG_FILE" 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null; true' EXIT

# Wait for READY
for i in $(seq 1 40); do
  if grep -q 'READY' "$LOG_FILE" 2>/dev/null; then break; fi
  sleep 0.25
done

BASE_URL=$(grep 'READY' "$LOG_FILE" | awk '{print $2}')
VAULT=$(grep 'VAULT' "$LOG_FILE" | awk '{print $2}')

if [ -z "$BASE_URL" ]; then
  echo "ERROR: server did not print READY" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "Server: $BASE_URL  Vault: $VAULT"

# Run Playwright
VOS214_S5_BASE_URL="$BASE_URL" \
VOS214_S5_VAULT="$VAULT" \
VOS214_S5_SHOT_DIR="$SHOT_DIR" \
VOS214_S5_TRUTH_OUT="$TRUTH_OUT" \
  bunx playwright test --config .e2e/playwright.vos214-s5.config.ts "$@"

echo "Screenshots: $SHOT_DIR"
echo "Truth JSON:  $TRUTH_OUT"
