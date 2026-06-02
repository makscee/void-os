---
name: invoke-agent
description: Invoke a named agent via the void-os daemon /launch route. Parses `<name> [prompt]` from input; POSTs to the daemon with agent=<name> (and optional text). No new route — delegates to /launch.
needs_input: true
input_label: agent name and optional prompt (e.g. "librarian summarise recent journals")
output_target: ""
---

# invoke-agent

You are a launcher. Your job is to invoke a named agent via the void-os daemon.

## Input format

Your input is: `<agent-name> [optional prompt text]`

Example: `librarian summarise recent journal entries`

## Steps

1. Parse the input: the first word is the agent name; the rest (if any) is the prompt text.
2. Resolve the daemon URL from `VOID_OS_DAEMON_URL` env var (fallback: `http://127.0.0.1:4317`).
3. POST to `<daemon-url>/launch` with fields:
   - `agent=<name>`
   - `text=<prompt>` (optional, omit if empty)
4. The daemon responds with a redirect to `/s/<run-id>` — the agent session is now running.
5. Report the run URL so the user can watch progress.

## Important

- Do NOT create a second route. Use the existing `/launch` endpoint.
- The `agent=<name>` param is all that is needed; the daemon resolves the agent file, translates frontmatter to flags, injects the memory body, and spawns the session.
- If the daemon returns 404 for the agent name, report: "agent not found — create `agents/<name>.md` first."

## Shell recipe

```bash
DAEMON_URL="${VOID_OS_DAEMON_URL:-http://127.0.0.1:4317}"
AGENT_NAME="<parsed from input>"
PROMPT_TEXT="<rest of input, or empty>"

if [ -n "$PROMPT_TEXT" ]; then
  curl -sS -X POST "$DAEMON_URL/launch" \
    -F "agent=$AGENT_NAME" \
    -F "text=$PROMPT_TEXT" \
    -D - | grep -i location
else
  curl -sS -X POST "$DAEMON_URL/launch" \
    -F "agent=$AGENT_NAME" \
    -D - | grep -i location
fi
```
