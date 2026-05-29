#!/bin/sh
# Fake runner fixture (VOS-182 e2e): proves the chosen command + argv reach the spawn.
# Records its argv, writes a body so the render loop completes, exits 0.
echo "FAKE-RUNNER ARGV: $*" >&2
uuid=""
while [ $# -gt 0 ]; do case "$1" in --session-id) uuid="$2"; shift 2;; *) shift;; esac; done
[ -n "$uuid" ] && printf '<h1>fake-runner ✓</h1>' > "sessions/$uuid/body.html"
exit 0
