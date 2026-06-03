#!/usr/bin/env bash
# VOS-214 Phase P2 — S8 no-html wedged-case runner.
# Boots vos214-s8-serve.ts, parses READY line, sets env vars, runs Playwright, tears down.
# Run from repo root: bash tests/e2e-run/vos214-s8.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SHOT_DIR="${SHOT_DIR:-$REPO_ROOT/vault/work/evidence/VOS-214/s8}"
TRUTH_OUT="${TRUTH_OUT:-/tmp/vos214-s8-truth.json}"
SERVE_LOG="$(mktemp /tmp/vos214-s8-serve-XXXX.log)"

mkdir -p "$SHOT_DIR"
: > "$TRUTH_OUT"

echo "[vos214-s8] booting serve harness..."
bun run .e2e/vos214-s8-serve.ts > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!

# Wait up to 10s for "READY http://..."
BASE_URL=""
for i in $(seq 1 40); do
  sleep 0.25
  LINE=$(grep "^READY " "$SERVE_LOG" 2>/dev/null || true)
  if [[ -n "$LINE" ]]; then
    BASE_URL="${LINE#READY }"
    break
  fi
done

if [[ -z "$BASE_URL" ]]; then
  echo "[vos214-s8] FAIL: harness never printed READY. Log:"
  cat "$SERVE_LOG"
  kill "$SERVE_PID" 2>/dev/null || true
  rm -f "$SERVE_LOG"
  exit 1
fi

echo "[vos214-s8] harness ready at $BASE_URL"

# Run Playwright
VOS214_S8_BASE_URL="$BASE_URL" \
VOS214_S8_TRUTH_OUT="$TRUTH_OUT" \
VOS214_S8_SHOT_DIR="$SHOT_DIR" \
  bunx playwright test --config .e2e/playwright.vos214-s8.config.ts
PW_STATUS=$?

# Tear down
kill "$SERVE_PID" 2>/dev/null || true
rm -f "$SERVE_LOG"

if [[ "$PW_STATUS" -eq 0 ]]; then
  echo "[vos214-s8] ALL TESTS PASSED"
  echo "[vos214-s8] screenshots: $SHOT_DIR"
  echo "[vos214-s8] truth: $TRUTH_OUT"
else
  echo "[vos214-s8] TESTS FAILED (exit $PW_STATUS)"
fi

exit "$PW_STATUS"
