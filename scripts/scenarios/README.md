# scenarios — pre-built smoke states

Scenario scripts orchestrate `smoke-up.sh` + the daemon HTTP API + Obsidian's
CDP debugger to land the smoke vault in a specific UI/conversation state, so
manual testing can start mid-flow instead of from a blank vault.

Run from any cwd:

```
bun /Users/admin/hub-wt/<ID>/workspace/void-os/scripts/scenarios/<name>.ts <ID>
```

Each scenario tears down any prior smoke for `<ID>`, brings up a fresh stack
under `/tmp/void-os-smoke/<ID>/`, drives Obsidian into the target state via
raw-WebSocket CDP, then hands off. Operator's main Obsidian is never touched
(scoped `pkill -f user-data-dir=...` matches only the smoke instance).

Tear down: `scripts/smoke-down.sh --purge <ID>`.

## Available scenarios

| Script | State at handoff |
|---|---|
| `tinker-chat-open.ts` | Smoke Obsidian open with the void-os chat panel active on a fresh Tinker conversation. Seed message asks Tinker to draft a new agent (`Eva`); Tinker's reply is already in the panel awaiting your confirmation. |

## How a scenario script is built

1. `smoke-down --purge` + `smoke-up --no-obsidian` — get the daemon + vault + plugin layout without launching the GUI yet.
2. POST `/chats` + `/chat/<id>/message` with a seed prompt; wait until the daemon's run resolves (or hits `input_required`).
3. Pin `chatId` into `<vault>/.obsidian/plugins/void-os/data.json` so the plugin opens on the seeded conversation.
4. Seed `<user-data-dir>/obsidian.json` with the smoke vault entry (`trusted: true`, `open: true`) so Obsidian opens it on launch instead of the starter screen.
5. Refuse to launch if the chosen CDP port is held by an unrelated process (otherwise we'd attach to the wrong target).
6. Spawn Obsidian via `open -na "Obsidian" --args --remote-debugging-port=<P> --user-data-dir=<U> <VAULT>`. Direct exec of the binary is LaunchServices-routed to the operator's running instance on macOS, defeating CDP — `open -na` produces a true second instance.
7. Poll `/json` until a target with `obsidian.md/index.html` appears (the loaded vault page, not `starter.html`).
8. Open raw WebSocket to the page target. Playwright's `connectOverCDP` hangs against Electron 33.3.2's browser-level CDP; raw WS works.
9. Poll for the Trust-author modal (Obsidian renders it post-load) and click. Then `app.plugins.enablePlugin('void-os')`, wait `void-os: connected` in the status bar, `app.commands.executeCommandById('void-os:open-chat-view')`.

Each scenario duplicates these steps inline rather than sharing a helper file
— mirrors the `plugin/e2e/specs/` "no helpers" convention so a future
refactor doesn't break manual testing in subtle ways.
