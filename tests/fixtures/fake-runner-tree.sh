#!/bin/sh
# fake-runner-tree.sh — runner that spawns a long-lived grandchild, proving tree-kill.
# A parent-only kill would orphan the grandchild; process-group kill kills both.
echo "FAKE-RUNNER-TREE ARGV: $*" >&2
uuid=""
while [ $# -gt 0 ]; do case "$1" in --session-id) uuid="$2"; shift 2;; *) shift;; esac; done
if [ -n "$uuid" ]; then
  mkdir -p "sessions/$uuid"
  printf '<title>running skill</title><p>skill is running…</p>' > "sessions/$uuid/body.html"
fi
# grandchild that would "finish anyway" if only the parent were killed:
( sleep 30; if [ -n "$uuid" ]; then printf '<title>LATE</title><p>orphan finished — body overwritten</p>' > "sessions/$uuid/body.html"; fi ) &
wait
