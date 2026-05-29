---
name: smoke-test
description: Cheap end-to-end smoke check — renders HTML and round-trips one form field. No research, no sub-agents.
---

# Smoke test

A minimal session that verifies the void-os render loop end-to-end at cold-start cost.
Do NOT use WebSearch, WebFetch, or sub-agents. Two turns only.

The session id is in the `VOID_OS_SESSION` environment variable. You render the page by
writing the file `body.html` inside this session's directory:
`sessions/<id>/body.html` (relative to your cwd, the vault), where `<id>` is the **actual
value** of `VOID_OS_SESSION`. First resolve that value (e.g. `echo "$VOID_OS_SESSION"`),
then use the resolved id in the real path — never write the literal text `$VOID_OS_SESSION`
into a file path.

## What to do

**Turn 1 (launch):** Write this session's `body.html` containing:
- `<h1>smoke-test ✓ session live</h1>`,
- a `<p>` echoing any launch input text you were given (or "no input" if none),
- a single `<form method="POST" action="/s/<id>/send">` (with `<id>` = the resolved
  session id) holding one text input named `echo` (placeholder "type anything") and a
  submit button.

Then stop. Do not reply in the terminal — `body.html` is the only output (render contract).

**Turn 2 (resume):** You will be resumed with a prompt containing `echo: <value>`.
Rewrite this session's `body.html` to:
- `<h1>round-trip ✓</h1>` and
- `<p>you sent: <value></p>`.

Then stop. Keep it to these two turns — this skill exists only to test the flow cheaply.
