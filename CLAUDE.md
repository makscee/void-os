# void-os repo location (relocated 2026-05-16)

Canonical path: `/Users/admin/hub/workspace/void-os` (was `~/void-os`). All VOS-* tasks tracked in hub at `/Users/admin/hub/vault/work/tasks/`. Workflow conventions in `/Users/admin/hub/CLAUDE.md` (Unified Workflow section). Worktrees stay at `~/void-os-wt/<ID>/` (NOT `~/hub-wt/`). Default branch: `main`. Direct push to GitHub allowed via `/done` (external repo merge per hub convention).

# E2E gotchas (plugin/e2e) — READ BEFORE WRITING SPECS

E2E loop is heavy: ~60-90s per run (daemon + Playwright + Obsidian + scripted LLM). Mistakes burn hours. Lessons from VOS-104 T8:

- **No reusable helpers exist.** There is no `createChatThatAsks` / `answerAskUser` / `daemon.api` helper module. Sibling specs build everything inline against `state.fakeScriptPath` + Playwright `request`. If a plan calls for one, lift the lower-level pattern from a working sibling spec.
- **Top-level orchestrator script is hard-pinned via `VOS_FAKE_SCRIPT_maya`** (set in `plugin/e2e/globalSetup.ts`). The agent picker does NOT route to different scripts — all chats run the maya script regardless of `agent_name`. Per-agent envs (`..._journaler`, `..._deep`) only apply to `ask_agent` *child* dispatches. To drive a top-level `vos_ask_user`, overwrite `plugin/e2e/fixtures/ask-agent/maya.jsonl` in `beforeEach` and restore in `afterEach`. Playwright `workers: 1` makes the swap race-free.
- **`ask-user.spec.ts` is broken on master** from the same script-pinning issue — do NOT copy it as a reference.
- **ChatList isEmpty filter hides rows with no text turns.** Plain `vos_ask_user`-only fixtures (e.g. `ask-with-options.jsonl`) produce rows that are filtered out. Emit at least one assistant text turn first ("thinking…") so the row renders.
- **Bun.serve `idleTimeout` must be raised for long ask_user waits.** Default 10s drops the `/events` stream before the operator can answer. Daemon sets `idleTimeout: 255` — keep it if touching daemon entrypoint.
- **Drive chats via REST when the picker isn't under test.** `POST /chats` + `POST /chat/:id/message` is faster and less flaky than UI picker. Save Playwright clicks for what the spec actually asserts.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
