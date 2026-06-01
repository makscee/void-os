#!/usr/bin/env bash
# vos-inbox-append.sh — reference event-inbox adapter.
# Appends one JSON line to a vault inbox. Real adapters (Telegram/Avito) are deferred;
# this proves the event Trigger path: `vos-inbox-append.sh <vault> <inbox> '<json>'`.
set -euo pipefail
VAULT="${1:?usage: vos-inbox-append.sh <vault> <inbox> <json-line>}"
INBOX="${2:?missing inbox name}"
LINE="${3:?missing json line}"
DIR="$VAULT/inbox"
mkdir -p "$DIR"
printf '%s\n' "$LINE" >> "$DIR/$INBOX.jsonl"
