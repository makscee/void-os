#!/usr/bin/env bash
# vos-run-wrapper.sh — tmux Run wrapper.
#
# Wraps the CC/vc subprocess in a tmux pane. On process exit it fires a synthetic
# "ProcessExit" event to the daemon so the registry can transition idle→exited_fail
# when the exit code is non-zero (CC doesn't have a StopFailure hook event; this
# wrapper bridges the gap without inventing CC hook names).
#
# Usage: vos-run-wrapper.sh <daemon-url> <run-id> <full-cc-command...>
#   e.g. vos-run-wrapper.sh http://127.0.0.1:4317 run-abc123 vc -- --session-id x ...
#
# stdin is redirected from /dev/null so that vc's TTY check does not block on a
# menu when launched in a tmux pane (which has a pseudo-TTY). vc skips its welcome
# menu when stdin is not a TTY.
#
# The daemon /hook endpoint accepts ProcessExit (a daemon-synthetic event, not a CC hook)
# and transitions the run to exited_fail when exit_code != 0.
# SessionEnd (fired by CC itself) handles the normal exit path → exited_ok.
set -uo pipefail

DAEMON_URL="${1:?daemon url required}"
RUN_ID="${2:?run id required}"
shift 2

# Run the CC command with stdin from /dev/null (avoids vc TUI on tty panes).
"$@" < /dev/null || true
EXIT_CODE=$?

# Post ProcessExit to daemon so it can transition to exited_fail if needed.
# This fires AFTER CC has already fired SessionEnd (which covers the normal exit).
# The daemon's handleHookEvent ignores ProcessExit when already in a terminal state.
VOS_EXIT_CODE="$EXIT_CODE" bun --eval "
  const exitCode = parseInt(process.env.VOS_EXIT_CODE ?? '0', 10);
  const body = JSON.stringify({ hook_event_name: 'ProcessExit', exit_code: exitCode, session_id: '' });
  fetch('$DAEMON_URL/hook?run=$RUN_ID', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => {}).finally(() => process.exit(0));
" 2>/dev/null
exit 0
