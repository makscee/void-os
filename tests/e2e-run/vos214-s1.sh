#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SHOT_BASE="${VOS214_SHOT_DIR:-vault/work/evidence/VOS-214}"
mkdir -p "$SHOT_BASE/s1" "$SHOT_BASE/s7"

LOG=$(mktemp)
bun .e2e/vos214-s1-serve.ts >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

# Wait for READY
for i in $(seq 1 50); do
  grep -q '^READY ' "$LOG" && break
  sleep 0.2
done

if ! grep -q '^READY ' "$LOG"; then
  echo "ERROR: serve harness did not print READY within 10s"
  cat "$LOG"
  exit 1
fi

export VOS214_S1_BASE_URL
VOS214_S1_BASE_URL=$(grep '^READY ' "$LOG" | awk '{print $2}')
export VOS214_S1_SESSION_IDS
VOS214_S1_SESSION_IDS=$(grep '^SESSION_IDS ' "$LOG" | sed 's/^SESSION_IDS //')
export VOS214_SHOT_DIR="$SHOT_BASE"

echo "Harness ready at $VOS214_S1_BASE_URL"
echo "Session IDs: $VOS214_S1_SESSION_IDS"

bunx playwright test --config .e2e/playwright.vos214-s1.config.ts
