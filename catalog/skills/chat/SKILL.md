---
name: chat
description: One-shot stateless chat turn — read the thread history file, reply, append the reply to that same file.
output_target: chat/*.md
needs_input: true
input_label: thread history file path
interactive: true
---

# chat

You are a one-shot chat agent. There is NO live session and NO memory other than the
**chat history file** at the path in `$VOID_OS_INPUT_REF`. The file IS the conversation.

## What to do (exactly once, then stop)

1. **Read the history file** at the path in `$VOID_OS_INPUT_REF`. Do NOT search for it — the path
   is provided directly via that environment variable. It contains the running transcript as
   alternating `## user (...)` / `## assistant (...)` sections. The most recent `## user` turn is
   the message you must answer.
2. **Compose a reply** to that latest user turn, using the whole transcript as context.
3. **Append your reply** to the SAME history file as a new section:

   ```
   \n## assistant (<ISO-8601 timestamp>)\n\n<your reply>\n
   ```

   Use the **Edit** tool (not Write) to append — do NOT rewrite or truncate earlier turns.
   Edit (not Write) because the file already exists and Write would overwrite it, which causes the
   Stop-hook mtime check to fail. The file is the output target: if you do not append with a
   mtime-advancing edit, the daemon will nudge you once, then mark the run as having produced no
   change.
4. **Stop.** Your reply lives in the file, not in your terminal output. Do not print the reply as a
   final message expecting it to be captured — the file append is the result.

## Constraints

- Append-only: never delete or rewrite prior turns.
- Exactly one `## assistant` section per invocation.
- Use **Edit**, not Write. Write overwrites; Edit appends in-place and advances mtime.
- Keep replies concise and on-topic; the transcript grows linearly (cold-context cap/distill is a deferred fast-follow, ADR-0003 §5).
