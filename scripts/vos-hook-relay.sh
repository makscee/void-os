#!/usr/bin/env bash
# vos-hook-relay.sh — CC lifecycle hook relay (command type).
#
# Claude Code fires this via a settings.json "type":"command" hook entry.
# CC pipes the hook JSON payload to this script's stdin before each lifecycle event.
# We forward it verbatim as a POST to the void-os daemon /hook endpoint.
#
# Two forms:
#   Per-exec (daemon-spawned):  "/path/to/vos-hook-relay.sh <daemon-url> <run-id>"
#     → POSTs to /hook?run=<run-id>
#   Vault-level (hand-launched): "/path/to/vos-hook-relay.sh <daemon-url>"
#     → POSTs to /hook (no run= param); daemon derives runId from payload.session_id
#
# Requirements: Bun in PATH (standard in void-os envs).
# Always exits 0 — a command hook must never stall CC with a non-zero exit.
set -uo pipefail

DAEMON_URL="${1:-}"
RUN_ID="${2:-}"

# Only daemon-url is mandatory; exit silently if missing.
[[ -z "$DAEMON_URL" ]] && exit 0

# Read full stdin (CC hook JSON payload).
PAYLOAD="$(cat 2>/dev/null || true)"

# Build the hook URL: include ?run= only when a run-id was provided (per-exec path).
# Vault-level path omits ?run= so the daemon derives runId from session_id in the payload.
# POST to daemon; AWAIT the response. If the daemon returns a Stop-hook decision
# ({"decision":"block",...}), echo EXACTLY that JSON to stdout so CC blocks the stop and
# re-prompts. For any other response ({"ok":...}) print nothing. Always exit 0 (a 5xx or
# network error must never stall CC — treat as "no decision").
RELAY_OUT="$(VOS_HOOK_PAYLOAD="$PAYLOAD" bun --eval "
  const body = process.env.VOS_HOOK_PAYLOAD ?? '{}';
  try {
    const run = '$RUN_ID';
    const url = run ? '$DAEMON_URL/hook?run=' + run : '$DAEMON_URL/hook';
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.decision === 'block') process.stdout.write(JSON.stringify({ decision: j.decision, reason: j.reason }));
  } catch { /* network/daemon down — no decision */ }
  process.exit(0);
" 2>/dev/null)"
# Emit ONLY the decision JSON (or nothing) on stdout — CC parses stdout as the hook result.
printf '%s' "$RELAY_OUT"
exit 0
