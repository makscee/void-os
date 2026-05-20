# void-os repo location (relocated 2026-05-16)

Canonical path: `/Users/admin/hub/workspace/void-os` (was `~/void-os`). All VOS-* tasks tracked in hub at `/Users/admin/hub/vault/work/tasks/`. Workflow conventions in `/Users/admin/hub/CLAUDE.md` (Unified Workflow section). Worktrees stay at `~/void-os-wt/<ID>/` (NOT `~/hub-wt/`). Default branch: `main`. Direct push to GitHub allowed via `/done` (external repo merge per hub convention).

# Manual smoke testing

Run `scripts/smoke-up.sh <ID>` from any task tab to stand up an isolated stack at `/tmp/void-os-smoke/<ID>/`. Operator's main daemon, main Obsidian, and `~/void` vault remain untouched. See `scripts/README.md` for the full command surface, per-file plugin symlink layout, and `daemonUrl` wiring.

Use when:
- Manual UX pass on a task's plugin changes
- Two task tabs both need a live daemon to test
- Plugin behavior depends on a fresh vault

Do not use:
- For E2E test runs (the Playwright harness in `plugin/e2e/` is the gate)
- To bake operator data — `/tmp/void-os-smoke/<ID>/` is ephemeral by design

First-time vault may require a one-time manual Enable in Obsidian (Settings → Community plugins → void-os); the enabled state persists in `<vault>/.obsidian/community-plugins.json` across subsequent smoke-up runs.

# Dogfood workflow (VOS-149)

`~/void-os-vault` is the operator's main vault. Every void-os task tab can deploy a fix into it in seconds and the operator reloads + verifies — no Obsidian restart.

Pieces:

- **`VOID_OS_PLUGIN_OUT` in shell rc.** Operator exports `VOID_OS_PLUGIN_OUT="$HOME/void-os-vault/.obsidian/plugins/void-os"` in `~/.zshrc`. Bare `bun run build` from any worktree then lands the plugin into the dogfood vault. `cli/init/plugin.ts:pluginBuildEnv` still pins its own `VOID_OS_PLUGIN_OUT` to `<prefix>/plugin/dist`, so init's plugin install ignores the exported value and won't pollute the dogfood vault.
- **Hot Reload sentinel.** `plugin/build.ts` ends by touching `<out>/.hotreload`. The Obsidian "Hot Reload" community plugin (https://github.com/pjeby/hot-reload, installed in `~/void-os-vault`) watches that filename and reloads void-os automatically — typically within ~1s of the build finishing.
- **`void-os daemon restart`.** Atomic stop + start. Cheaper than `stop && start` because it's one CLI call; the plugin reconnects automatically on the next health probe. Use after daemon/cli/protocol changes. Skip when only plugin code changed (a restart drops in-flight chats for no behavioural gain).
- **`/deploy-dogfood` skill.** Hub-level skill at `~/hub/.claude/skills/deploy-dogfood/`. After a fix commit, invoke "deploy to dogfood" / "/deploy-dogfood" — the skill runs `VOID_OS_PLUGIN_OUT=… bun run build` and conditionally restarts the daemon based on the diff.

Coexists with smoke harness: dogfood Obsidian and `scripts/smoke-up.sh <ID>` use disjoint `VOID_OS_HOME` and ports (smoke draws 78XX, dogfood uses 7777), so concurrent smoke + dogfood iterations don't collide. If `launchctl setenv VOID_OS_HOME` from a smoke run somehow leaks into an already-running dogfood Obsidian, `smoke-down.sh` clears it; otherwise launch dogfood Obsidian BEFORE smoke so it inherits a clean env.

One-time operator setup (NOT auto-bootstrapped by any skill):

1. `export VOID_OS_PLUGIN_OUT="$HOME/void-os-vault/.obsidian/plugins/void-os"` in `~/.zshrc`.
2. `git clone https://github.com/pjeby/hot-reload ~/void-os-vault/.obsidian/plugins/hot-reload && jq '. + ["hot-reload"]' ~/void-os-vault/.obsidian/community-plugins.json > /tmp/cp && mv /tmp/cp ~/void-os-vault/.obsidian/community-plugins.json` (idempotent edit). Enable in Settings → Community plugins.
3. Install void-os into the dogfood vault once: `void-os plugin install --vault ~/void-os-vault`.

# E2E gotchas (plugin/e2e) — READ BEFORE WRITING SPECS

E2E loop is heavy: ~60-90s per run (daemon + Playwright + Obsidian + scripted LLM). Mistakes burn hours. Lessons from VOS-104 T8:

- **Reusable helpers (VOS-127):** `plugin/e2e/helpers/` — `vault-page.ts` exposes `getVaultPage(cdpPort, opts?)` to connect to CDP, accept the Trust Author dialog, wait for `domcontentloaded`; `daemon-api.ts` exposes `mintChat`, `sendMessage`, `openEventsWs`, `callAskAgentOverMcp` against the local daemon; `fixture-swap.ts` exposes `withFixtureSwap(path, contents, fn)` for race-free swap/restore with a LOUD trap-3 guard. Default `bun run e2e` runs only the `main` Playwright project (1 Obsidian window); use `bun run e2e:all` to run all 4 projects.
- **Top-level orchestrator script is hard-pinned via `VOS_FAKE_SCRIPT_maya`** (set in `plugin/e2e/globalSetup.ts`). The agent picker does NOT route to different scripts — all chats run the maya script regardless of `agent_name`. Per-agent envs (`..._journaler`, `..._deep`) only apply to `ask_agent` *child* dispatches. To drive a top-level `vos_ask_user`, overwrite `plugin/e2e/fixtures/ask-agent/maya.jsonl` in `beforeEach` and restore in `afterEach`. Playwright `workers: 1` makes the swap race-free.
- **`ask-user.spec.ts` is broken on master** from the same script-pinning issue — do NOT copy it as a reference.
- **ChatList isEmpty filter hides rows with no text turns.** Plain `vos_ask_user`-only fixtures (e.g. `ask-with-options.jsonl`) produce rows that are filtered out. Emit at least one assistant text turn first ("thinking…") so the row renders.
- **Bun.serve `idleTimeout` must be raised for long ask_user waits.** Default 10s drops the `/events` stream before the operator can answer. Daemon sets `idleTimeout: 255` — keep it if touching daemon entrypoint.
- **Drive chats via REST when the picker isn't under test.** `POST /chats` + `POST /chat/:id/message` is faster and less flaky than UI picker. Save Playwright clicks for what the spec actually asserts.
- **Ribbon icon clicks must use `vaultPage.evaluate(el => el.click())`, not `locator.click()`.** Obsidian renders ribbon items as bare `<div class="clickable-icon side-dock-ribbon-action" aria-label="…">` (not buttons). Playwright's actionability check hangs the full 60s test timeout even when the element is visible; `force: true` clicks but doesn't fire Obsidian's delegated handler. Dispatch the native click in-page. Caught VOS-139 2026-05-18.

# Typecheck discipline — tsc is heavy, serialize it (HUB-36)

void-os `tsc --noEmit` is a multi-minute job. Several task tabs running it
concurrently pin every core, exhaust swap, and slow each run 9-12x. Under
that pressure a subagent's 2-minute Bash timeout fires while tsc is merely
slow, the subagent reads timeout as failure and retries — doubling the load.

Rules for any agent typechecking void-os:

- **Prefer `bun test`.** It is the verification gate. A scoped `bun test`
  on the touched workspace catches the regressions you care about far
  faster than a cold full-project `tsc --noEmit`. Only run tsc when a
  change is type-shape-only (no runtime behaviour to test).
- **Never launch parallel tsc.** Route every `tsc --noEmit` through the
  hub serializer `/Users/admin/hub/tools/typecheck-lock/tc` — it holds a
  machine-wide flock so at most one tsc runs at a time; others queue.
- **Never retry tsc on a Bash timeout.** A timeout means "still running,"
  not "failed." `tc` runs tsc detached and returns a status-file path; poll
  that file instead of re-invoking tsc.
- **Incremental is on.** All three tsconfigs set `incremental` +
  `tsBuildInfoFile` (under each workspace's `node_modules/.cache/`, so
  per-worktree, gitignored). A warm repeat run reuses the cache and is
  near-instant — do not delete the cache "to be safe."

`bun run typecheck` exists in `plugin`, `daemon`, and `protocol`.

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
