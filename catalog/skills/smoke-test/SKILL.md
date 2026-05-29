---
name: smoke-test
description: Cheap end-to-end smoke check — renders HTML and round-trips one form field. No research, no sub-agents.
---

# Smoke test

A minimal session that verifies the void-os render loop end-to-end at cold-start cost.
Do NOT use WebSearch, WebFetch, or sub-agents. Two turns only. The body file you write
is `sessions/$VOID_OS_SESSION/body.html` (relative to the vault, which is your cwd).

## What to do

**Turn 1 (launch):** Write `sessions/$VOID_OS_SESSION/body.html` containing:
- `<h1>smoke-test ✓ session live</h1>`,
- a `<p>` echoing any launch input text you were given (or "no input" if none),
- a single `<form action="/s/$VOID_OS_SESSION/send" method="POST">` with one text input
  named `echo` (placeholder "type anything") and a submit button.

Then stop. Do not reply in the terminal — `body.html` is the only output (render contract).

**Turn 2 (resume):** You will be resumed with a prompt containing `echo: <value>`.
Rewrite `sessions/$VOID_OS_SESSION/body.html` to:
- `<h1>round-trip ✓</h1>` and
- `<p>you sent: <value></p>`.

Then stop. Keep it to these two turns — this skill exists only to test the flow cheaply.
