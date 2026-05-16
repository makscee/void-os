# plugin/e2e — Playwright Electron + fake-Provider harness

End-to-end tests booting real Obsidian + built plugin + isolated void-os daemon. Uses Playwright's `chromium.connectOverCDP` against Obsidian's `--remote-debugging-port` (the standard pattern for Squirrel-packaged Electron apps).

## Prereqs

- macOS (v1 is macOS-headed only)
- bun (this repo's package manager)
- Internet access on first run (downloads pinned Obsidian binary into `plugin/e2e/.cache/`)

## Run

```bash
cd plugin
bun run e2e
```

`globalSetup` (idempotent per run, ~5s overhead):
1. Picks two free ports (daemon HTTP + Obsidian CDP)
2. Copies `fixtures/vault/` → `<tmpdir>/fixture-vault/` (so Obsidian's runtime writes never touch the committed fixture)
3. Builds the plugin into the tmp fixture's `.obsidian/plugins/void-os/`
4. Writes `data.json` with the resolved `daemonUrl`
5. Spawns the daemon with `VOS_PROVIDER=fake`, `VOS_TITLER=stub`, `VOID_OS_DB` + `VOID_OS_VAULT_ROOT` pointing into tmpdir, `ANTHROPIC_API_KEY` deleted from env
6. Spawns Obsidian with `--remote-debugging-port=<cdp>` + `--user-data-dir=<tmpdir>/obsidian-user-data`
7. Pre-seeds `obsidian.json` with `trusted: true` (skip Trust Author modal) + `updateDisabled: true` (no mid-run auto-update)
8. Polls daemon HTTP + Obsidian CDP for readiness
9. Persists state to `<tmpdir>/state.json` and exports `VOS_E2E_STATE`

`globalTeardown` SIGTERMs Obsidian + daemon (SIGKILL fallback after 2s) and `rm -rf`s tmpdir.

## Add a spec

```ts
import { test, expect, chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test("...", async () => {
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as {
    port: number;
    cdpPort: number;
    vaultPath: string;
    obsidianUserDataDir: string;
  };

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);
  try {
    let page = browser.contexts().flatMap(ctx => ctx.pages())
      .find(p => p.url() === "app://obsidian.md/index.html");
    if (!page) {
      page = await browser.contexts()[0].waitForEvent("page", {
        predicate: (p: Page) => p.url() === "app://obsidian.md/index.html",
        timeout: 20_000,
      });
    }
    await page.waitForLoadState("domcontentloaded");

    // Trust modal — only on first cold boot when obsidian.json `trusted` flag was missed.
    try {
      await page.getByRole("button", { name: /Trust author/i }).click({ timeout: 5_000 });
    } catch { /* already trusted */ }

    // Status pill precondition.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // ... your assertions ...
  } finally {
    await browser.close();
  }
});
```

## Patterns & gotchas (read this before writing a spec)

| Gotcha | Fix |
|---|---|
| `_electron.launch()` errors against packaged Obsidian.app | Use `chromium.connectOverCDP("http://127.0.0.1:" + cdpPort)`. globalSetup launches Obsidian with `--remote-debugging-port` already. |
| Trust modal blocks plugin load on a cold profile | `obsidian.json` already has `trusted: true` per vault. If your run starts before the flag is honored, defensively `try { page.getByRole("button", { name: /Trust author/i }).click({ timeout: 5_000 }); } catch {}`. |
| Obsidian opens a Settings / Community-plugins modal on first launch | Press `Escape` once or twice after opening any plugin view to dismiss any modal layered over the workspace. |
| Opening the chat view | `await page.evaluate(() => window.app.commands.executeCommandById("void-os:open-chat-view"))`. Wait for `getByTestId("vos-chat-root")` to be visible afterward. |
| Empty chats are hidden from the ChatList by design (`isEmpty` filter) | Don't assert on `data-testid="chat-row"` before the first message lands — the chat exists in the daemon DB but isn't rendered until it has a title or `last_msg`. |
| `data-testid="queue-send"` only exists while a run is in flight | For the FIRST message use `getByRole("button", { name: "Send" })` — that's `ComposerPrimitive.Send`. `queue-send` is the swap when `handle.isRunning === true`. |
| Raw `fetch` from `app://obsidian.md` is CORS-blocked by Obsidian's renderer | The plugin uses `requestUrl` (Obsidian-shipped, out-of-process). Tests that want to probe the daemon should hit it from Node (the test runner itself can `await fetch(...)` no problem) — NOT from `page.evaluate()`. |
| `require("obsidian")` inside `page.evaluate` errors | `obsidian` is only resolvable inside the plugin bundle. Don't try to call `requestUrl` from the spec context. |
| Strict-mode locator violations on common text | Multiple parts of the chat UI render the same text (thread message AS `<p>` + chat-list row AS `<span>` preview). Scope assertions: `chatRoot.getByRole("paragraph").filter({ hasText: "..." })` for the rendered markdown. |
| DOM `.click()` doesn't always trigger React 17+ event delegation | Prefer `page.getByTestId(...).click({ force: true })` — real pointer event, dispatches to React root. `force: true` skips Playwright's actionability heuristic for elements nested in Obsidian's quirky layout. |
| Auto-update hot-swaps `obsidian.asar` mid-run and unloads the plugin | Already handled — `obsidian.json` has `updateDisabled: true`. Don't remove it. |
| Fixture vault gets polluted by Obsidian writes (`workspace.json`, etc.) | Already handled — `globalSetup` copies `fixtures/vault/` → `<tmpdir>/fixture-vault/` before launching Obsidian. Edit the SOURCE fixture; tmp copy gets refreshed each run. |
| `bun test` would otherwise sweep up `*.spec.ts` and choke on Playwright's `test()` | `plugin/bunfig.toml` scopes Bun's discovery to `plugin/test/`. Playwright runs via the `e2e` script. Don't put unit tests under `plugin/e2e/specs/`. |

## Adding new `data-testid` attributes

Convention: `data-testid="vos-<kebab-area>"`. v1 ships two from main.ts + ChatRoot:
- `vos-status-bar` (Obsidian status bar pill)
- `vos-chat-root` (chat view root container)

Other testids that already exist in the chat UI (from product code, not added for e2e but usable by specs):
- `chat-list`, `new-chat-btn`, `chat-row`
- `queue-send` (only during a run; see gotcha)
- `queued-content`, `queued-badge`, `stopped-badge`, `timeout-notice`, `error-notice`, `esc-hint`

When adding new specs, prefer using these existing testids over inventing new ones. If you need to add a new testid to product code, scope it to a specific React component, kebab-case, and document it here.

## Fake-Provider JSONL format

The fake provider replays a JSONL file at `VOS_FAKE_SCRIPT` (set by globalSetup to `fixtures/cc/hello.jsonl`). Each line is one raw `ProviderEvent` (see `daemon/src/providers/types.ts`).

The default `hello.jsonl`:

```jsonl
{"type":"system","subtype":"init","session_id":"e2e-hello"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake"}]}}
```

The daemon's orchestrator (`daemon/src/chat/orchestrator.ts`) turns the assistant event into `chat.token` WS frames with `delta = "hello from fake"`. The plugin's runtime reducer accumulates tokens and renders them as a `<p>` inside the thread.

For tests that don't actually send a message, the canned events don't matter (the fake provider only emits them on `spawn()`, which is only called from the chat orchestrator). `fixtures/cc/empty.jsonl` (system init only) is kept around for posterity.

To exercise tool calls: emit an assistant event with `content: [{ type: "tool_use", id: "...", name: "Bash", input: { command: "..." } }]` plus a follow-up user event with `tool_result` content. See `extractToolUses` / `extractToolResults` in `daemon/src/providers/claude-code/extract.ts` for the exact shape.

## Known limitations (v1)

- **macOS-headed only.** Linux/CI deferred. AppImage + xvfb path is a separate follow-up task.
- **`workers: 1`.** Electron + Obsidian don't tolerate multiple instances on the same `--user-data-dir`. Specs share one Obsidian instance per run.
- **Spec order matters less than test isolation.** Specs share daemon state across runs. The first to send a message creates DB rows; later specs see them. Each spec should mint its own chat if it needs a clean slate.
- **Free-port → daemon-listen has a small TOCTOU window.** Acceptable on a dev workstation; revisit before CI.
- **Local Obsidian binary cache** under `plugin/e2e/.cache/` (see below). The host install is not used.

## Obsidian binary cache

The harness owns its own Obsidian binary under `plugin/e2e/.cache/` (gitignored). `globalSetup.ts` calls `ensureObsidian()` from `plugin/e2e/obsidian-cache.ts`, which downloads the pinned `Obsidian-<VERSION>.dmg` on first run and reuses the extracted `.app` on every subsequent run. The host's `/Applications/Obsidian.app` is never touched.

- **Where:** `plugin/e2e/.cache/Obsidian.app/Contents/MacOS/Obsidian`
- **Version pin:** `OBSIDIAN_VERSION` const in `plugin/e2e/obsidian-cache.ts`
- **First run:** one-time download + extract (~30–90s depending on network).
- **Subsequent runs:** unchanged speed (~5s globalSetup overhead).
- **How to clear:** `rm -rf plugin/e2e/.cache`. Next `bun run e2e` re-downloads.
- **How to bump version:** edit `OBSIDIAN_VERSION` in `plugin/e2e/obsidian-cache.ts`. Next run wipes the cached bundle and re-downloads — no manual cleanup.
- **Concurrency:** two parallel runs serialize via `plugin/e2e/.cache/.download.lock`. SIGKILL or hard reboot during a download is auto-recovered on the next run via a pidfile + mtime stale-lock heuristic.
- **Platform:** macOS-only. Linux/CI support is a separate follow-up.
- **Manual smoke test of the cache itself:** `bun run e2e/scripts/test-obsidian-cache.ts` from the `plugin/` directory.
