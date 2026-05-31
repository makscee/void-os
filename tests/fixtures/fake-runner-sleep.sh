#!/bin/sh
# Fake runner that writes a placeholder body then sleeps — used by Stop tests to keep process alive.
echo "FAKE-RUNNER-SLEEP ARGV: $*" >&2
uuid=""
while [ $# -gt 0 ]; do case "$1" in --session-id) uuid="$2"; shift 2;; *) shift;; esac; done
if [ -n "$uuid" ]; then
  mkdir -p "sessions/$uuid"
  printf '<title>running skill</title><p>skill is running…</p>' > "sessions/$uuid/body.html"
fi
sleep 30
exit 0
