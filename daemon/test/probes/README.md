# daemon/test/probes

End-to-end probes that spin a live in-process daemon and run **real** Claude
Code subprocesses via `claudev`. Not unit tests. Not part of `bun test`.
Run them explicitly:

    bun test:probes

## loader-integration.ts (VOS-106)

Six cross-agent routing probes against a fixture vault at
`daemon/test/fixtures/probe-vault/`. Pass when ≥5/6 strict-match the
expected behavior (the `expectRegex` per probe). The single permitted
non-pass is `PROBE_DESIGN_BUG` (harness error, not a routing regression).

Each probe creates a fresh chat for a starter-vault agent and asks a
question that exercises a cross-agent boundary. Expected behavior is that
the agent surfaces `ask_agent("<peer>", ...)` rather than reaching for
`Read` directly. The PreToolUse hook (VOS-106) is what makes this work —
without it, agents have full default tool access and bypass the routing.
