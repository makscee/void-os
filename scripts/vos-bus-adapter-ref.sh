#!/usr/bin/env bash
# vos-bus-adapter-ref.sh — reference inbound-bus ADAPTER (a second channel, channel="web").
# Mirrors the VOS-189 stub-adapter pattern: a thin shim that translates an external message
# into a bus line. Real Telegram/web-input adapters are their own follow tasks (VOS-193/194-era);
# this proves a non-"file" channel flows end-to-end through the same parse→route→fire path.
# Usage: vos-bus-adapter-ref.sh <vault> <inbox> <kind> <payload>
set -euo pipefail
VAULT="${1:?usage: vos-bus-adapter-ref.sh <vault> <inbox> <kind> <payload>}"
INBOX="${2:?missing inbox}"; KIND="${3:?missing kind}"; PAYLOAD="${4:?missing payload}"
ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"; TS=$(( $(date +%s) * 1000 ))
DIR="$VAULT/inbox"; mkdir -p "$DIR"
LINE=$(KIND="$KIND" PAYLOAD="$PAYLOAD" ID="$ID" TS="$TS" \
  bun --eval 'const e=process.env; process.stdout.write(JSON.stringify({channel:"web",kind:e.KIND,payload:e.PAYLOAD,routing:{},id:e.ID,ts:Number(e.TS)}))')
printf '%s\n' "$LINE" >> "$DIR/$INBOX.jsonl"
echo "$ID"
