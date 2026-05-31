#!/usr/bin/env bash
# verify.sh — the single scriptable green/red gate for void-os.
# Exit 0 = green (safe to check a box), non-zero = red.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== bunx tsc --noEmit =="
bunx tsc --noEmit
echo "== bun test =="
bun test --isolate
echo "VERIFY GREEN"
