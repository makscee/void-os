#!/usr/bin/env bash
# Pure helpers for smoke-up/down/dogfood. Source me; do not exec me.
# All functions either return value via stdout or set named globals.

# compute_port <ID>
# echoes 7800 + cksum(ID) % 100. Deterministic.
compute_port() {
  local id="$1"
  printf '%s' "$id" | cksum | awk '{print 7800 + ($1 % 100)}'
}

# resolve_paths <ID>
# emits eval-able lines setting SMOKE_ROOT, SMOKE_VAULT, SMOKE_HOME,
# SMOKE_USERDATA, SMOKE_PIDFILE, SMOKE_PORTFILE, SMOKE_OBSIDIAN_PIDFILE,
# SMOKE_LOG.
resolve_paths() {
  local id="$1"
  local root="/tmp/void-os-smoke/$id"
  cat <<EOF
SMOKE_ROOT="$root"
SMOKE_VAULT="$root/vault"
SMOKE_HOME="$root/home"
SMOKE_USERDATA="$root/obsidian-user-data"
SMOKE_PIDFILE="$root/daemon.pid"
SMOKE_PORTFILE="$root/daemon.port"
SMOKE_OBSIDIAN_PIDFILE="$root/obsidian.pid"
SMOKE_LOG="$root/daemon.log"
EOF
}

# pid_alive <pid>
# 0 if pid is a live process owned by current user; 1 otherwise.
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  # `kill -0` returns 0 if pid exists AND we have signal permission.
  kill -0 "$pid" 2>/dev/null
}

# kill_grace <pid> [graceSeconds]
# TERM, wait up to graceSeconds (default 2), then KILL. Always returns 0.
kill_grace() {
  local pid="$1"
  local grace="${2:-2}"
  pid_alive "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while [ "$i" -lt "$grace" ] && pid_alive "$pid"; do
    sleep 1
    i=$((i+1))
  done
  if pid_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  return 0
}

# Audited in Task 1. Update here if daemon logging or plugin URI handlers
# change. smoke-dogfood reads these; no duplication elsewhere.
#   - SMOKE_DAEMON_CONNECT_GREP: regex matching a plugin-originated HTTP
#     request line in daemon.log
#   - SMOKE_PLUGIN_TRIGGER_URI: obsidian:// URI that round-trips a request
#     through the daemon. Empty string if no such handler exists; in that
#     case smoke-dogfood relies on cold-start autofire (set during T1).
SMOKE_DAEMON_CONNECT_GREP='void-os daemon v[0-9.]+ listening on http://'
SMOKE_PLUGIN_TRIGGER_URI=''

# read_port_or_compute <ID> <root>
# echoes the port to use. Prefers $root/daemon.port if it exists (sticky).
# Else compute_port + lsof probe-bump, writes the chosen port to file.
# Exit 4 if 7800-7899 all bound.
read_port_or_compute() {
  local id="$1"
  local root="$2"
  local portfile="$root/daemon.port"
  if [ -f "$portfile" ]; then
    cat "$portfile"
    return 0
  fi
  local base p
  base="$(compute_port "$id")"
  p="$base"
  local tries=0
  while [ "$tries" -lt 100 ]; do
    if ! lsof -i ":$p" -sTCP:LISTEN -t >/dev/null 2>&1; then
      mkdir -p "$root"
      printf '%s\n' "$p" > "$portfile"
      echo "$p"
      return 0
    fi
    p=$((p + 1))
    [ "$p" -gt 7899 ] && p=7800
    tries=$((tries+1))
  done
  echo "smoke: no free port in 7800-7899" >&2
  return 4
}
