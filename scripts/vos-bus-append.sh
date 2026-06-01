#!/usr/bin/env bash
# vos-bus-append.sh — file-channel inbound-bus helper. Builds a valid bus line and appends it.
# Usage: vos-bus-append.sh <vault> <inbox> <kind> <payload> [routing-json]
# Generalizes vos-inbox-append.sh: emits channel/kind/payload/routing/id/ts, not a bare blob.
set -euo pipefail
VAULT="${1:?usage: vos-bus-append.sh <vault> <inbox> <kind> <payload> [routing-json]}"
INBOX="${2:?missing inbox}"
KIND="${3:?missing kind (idea|chat|decision-reply)}"
PAYLOAD="${4:?missing payload}"
ROUTING="${5:-{}}"
ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
TS=$(( $(date +%s) * 1000 ))
DIR="$VAULT/inbox"; mkdir -p "$DIR"
LINE=$(KIND="$KIND" PAYLOAD="$PAYLOAD" ROUTING="$ROUTING" ID="$ID" TS="$TS" \
  bun --eval 'const e=process.env; process.stdout.write(JSON.stringify({channel:"file",kind:e.KIND,payload:e.PAYLOAD,routing:JSON.parse(e.ROUTING),id:e.ID,ts:Number(e.TS)}))')
printf '%s\n' "$LINE" >> "$DIR/$INBOX.jsonl"
echo "$ID"
