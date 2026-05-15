# VOS-93 — Plugin e2e harness (Playwright Electron + fake Provider)

**Status:** design approved 2026-05-15
**Task:** `hub/vault/work/tasks/active/VOS-93-plugin-e2e-harness-playwright-electron.md`
**Repo:** void-os
**Branch:** `task/VOS-93`

## Goal

Agent-runnable end-to-end test that boots **real Obsidian + built plugin + isolated daemon** together, with a deterministic, LLM-free fake provider. Ships harness + one smoke spec. Per-surface specs (chat round-trip, cancel, agent picker, reconnect) are explicit follow-up tasks.

## Non-goals (v1)

- Linux / CI / xvfb / AppImage. macOS-headed only.
- More than one spec.
- Multiple test-id coverage (only what smoke needs).
- Replacing existing 61 plugin unit tests + 53 daemon contract tests.

## Components

### 1. Fake Provider (daemon)

- Path: `daemon/src/providers/fake/` (new), sibling of `claude-code/`.
- Implements `Provider` from `daemon/src/providers/types.ts` exactly (no interface change).
- `spawn(req)` returns a `ProviderHandle` whose `events` AsyncIterable yields lines parsed from a JSONL file at `process.env.VOS_FAKE_SCRIPT`. Each line is a `ProviderEvent`. EOF ⇒ stream closes; `done` resolves `{ reason: "exit", exitCode: 0 }`.
- No child process. No `claude` binary. No Anthropic SDK import.
- Selection: new file `daemon/src/providers/factory.ts` exports `makeProvider(env, deps): Provider` reading `process.env.VOS_PROVIDER` (default `"claude-code"`). `"fake"` ⇒ instantiate fake (satisfies bare `Provider` interface). `"claude-code"` ⇒ delegate to `makeClaudeCodeProviderComposed(deps)`. `app.ts` calls `makeProvider(...)` instead of inlining `makeClaudeCodeProviderComposed(...)`. The composed wrapper stays — only the call site changes.
- `cancel()` flips an internal flag that ends iteration on next tick; resolves `true` if not already done.
- Test coverage: unit test for fake provider (replays a fixture, asserts event sequence + cancel + done shape) lives in `daemon/src/providers/fake/__tests__/`.

### 1.5. Titler stub (boot hermeticity)

- `buildApp` constructs a `Titler` via `buildAnthropicSdk()` → `fetchAnthropicKey()` (network call to void-keys). With `ANTHROPIC_API_KEY=""` this hangs or errors during e2e setup.
- Add `VOS_TITLER` env knob: `"stub"` ⇒ no-op titler (returns `null` / empty string for any title request, never hits network). Auto-on when `VOS_PROVIDER=fake` if `VOS_TITLER` unset.
- Implementation lives next to the existing titler construction site (likely `daemon/src/chat/titler.ts` or wherever `buildAnthropicSdk()` is called). Same shape as fake provider: simple env-driven swap, no production behavior change when env unset.
- e2e globalSetup sets `VOS_TITLER=stub` explicitly (belt + suspenders) and asserts daemon boots with no `ANTHROPIC_API_KEY` set.

### 2. Plugin `daemonUrl` setting

- Add `daemonUrl?: string` field to plugin settings type (file: `plugin/src/chat/settings.ts` — confirm exact path during impl).
- `plugin/src/main.ts`: replace the two hardcoded constants
  ```
  const DAEMON_HTTP = "http://127.0.0.1:7777";
  const DAEMON_WS   = "ws://127.0.0.1:7777/events";
  ```
  with derivation from `settings.daemonUrl ?? "http://127.0.0.1:7777"`. WS URL = HTTP URL with `http→ws` + `/events` suffix.
- Settings tab: single text input labelled "Daemon URL". Placeholder = default. Save persists to `data.json`.
- Backwards-compat: missing field ⇒ default. No migration needed.

### 3. Daemon isolation env vars (already exist)

Daemon `src/index.ts` already reads:

- `VOID_OS_DB` — sqlite file path.
- `VOID_OS_VAULT_ROOT` — vault directory (must exist on disk; daemon exits 2 if missing). Traces dir is derived as `path.join(vaultRoot, ".traces")`.

e2e uses both, no daemon patch needed:
- `VOID_OS_DB = <tmpdir>/state.sqlite`
- `VOID_OS_VAULT_ROOT = <tmpdir>/vault` (globalSetup creates dir + a `welcome.md` first so daemon boots)

### 4. e2e harness — `plugin/e2e/`

```
plugin/e2e/
  playwright.config.ts
  globalSetup.ts
  globalTeardown.ts
  fixtures/
    vault/
      welcome.md
      .obsidian/
        community-plugins.json     # ["void-os"]
        app.json                   # license-nag-skipped flags
        plugins/
          void-os/
            .gitkeep               # populated at setup by `bun run build`
            data.json.tmpl         # template; setup writes resolved data.json
    cc/
      empty.jsonl                  # one-line system event
  specs/
    connect.spec.ts
  helpers/
    state.ts                       # exports port + daemon PID via env or filesystem
  README.md
```

#### `playwright.config.ts`

- `testDir: "./specs"`
- `globalSetup: "./globalSetup.ts"` / `globalTeardown: "./globalTeardown.ts"`
- Single project (no parallel workers in v1: only one Obsidian instance per run).
- `use: { headless: false }` (Electron always headed).
- `timeout: 60_000`.

#### `globalSetup.ts` (sequence, all happen here)

1. Make per-run tmpdir under `os.tmpdir()/void-os-e2e-<rand>/`.
2. Pick free port: `await new Promise(...)` on `net.createServer().listen(0)` → grab `address().port` → close.
3. Run plugin build into fixture:
   ```
   spawn("bun", ["run", "build.ts"], {
     cwd: "<plugin-root>",
     env: { ...process.env, VOID_OS_PLUGIN_OUT: "<plugin/e2e/fixtures/vault/.obsidian/plugins/void-os>" },
     stdio: "inherit",
   })
   ```
   Wait for exit 0.
4. Write resolved `data.json` at `fixtures/vault/.obsidian/plugins/void-os/data.json`:
   ```json
   { "daemonUrl": "http://127.0.0.1:<port>" }
   ```
5. Spawn daemon detached:
   ```
   spawn("bun", ["run", "src/index.ts"], {
     cwd: "<daemon-root>",
     env: {
       ...process.env,
       VOID_OS_PORT: String(port),
       VOID_OS_DB: "<tmpdir>/state.sqlite",
       VOID_OS_VAULT_ROOT: "<tmpdir>/vault",
       VOS_PROVIDER: "fake",
       VOS_TITLER: "stub",
       VOS_FAKE_SCRIPT: "<plugin/e2e/fixtures/cc/empty.jsonl>",
       ANTHROPIC_API_KEY: "",
     },
     stdio: ["ignore", "pipe", "pipe"],
   })
   ```
6. Wait for daemon readiness: poll `GET http://127.0.0.1:<port>/healthz` (or whatever exists; grep `daemon/src/app.ts` during impl; if none, use `GET /` and accept any 2xx/4xx). Timeout 10s ⇒ fail setup.
7. Write `<tmpdir>/state.json` with `{ port, daemonPid, tmpdir, vaultPath, obsidianUserDataDir }`. Export `process.env.VOS_E2E_STATE = state.json path` so specs + teardown can read it.

#### `globalTeardown.ts`

- Read `state.json`. `process.kill(daemonPid, "SIGTERM")`. Wait ≤5s for exit (poll). On timeout, `SIGKILL`. `rm -rf` tmpdir.

#### `specs/connect.spec.ts`

```ts
import { test, expect, _electron as electron } from "@playwright/test";
import { readFileSync } from "node:fs";

test("plugin boots and connects to daemon", async () => {
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8"));
  const app = await electron.launch({
    executablePath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    args: [
      `--user-data-dir=${state.obsidianUserDataDir}`,
      state.vaultPath,
    ],
  });
  const win = await app.firstWindow();
  const pill = win.getByTestId("vos-status-bar");
  await expect(pill).toHaveText("void-os: connected", { timeout: 15_000 });
  // Heartbeat proof: still connected after >1× ping cycle. ReconnectFSM's
  // pingMs is constructor-injected, not exported. main.ts wires production
  // value at boot; tests should import the same constant from the wire-up
  // module. If no exported constant yet, T7 adds `export const DEFAULT_PING_MS`
  // alongside the FSM construction site (likely main.ts) and the spec imports
  // it. Until then, hardcode 5_000 (5s) and document in README.
  await win.waitForTimeout(DEFAULT_PING_MS * 2);
  await expect(pill).toHaveText("void-os: connected");
  await app.close();
});
```

#### `fixtures/cc/empty.jsonl`

```json
{"type":"system","subtype":"init","session_id":"e2e-smoke"}
```

#### `fixtures/vault/.obsidian/community-plugins.json`

```json
["void-os"]
```

#### `fixtures/vault/.obsidian/app.json`

Minimal flags that skip first-run nags. Exact key list to confirm during impl by booting a fresh fixture vault once and copying the resulting file.

### 5. data-testid additions

Exactly two:

- `plugin/src/status.ts` — wrap the status-bar text node in a span with `data-testid="vos-status-bar"`. Obsidian's `StatusBarItem` accepts arbitrary DOM; check the API or wrap inside the element passed in.
- `plugin/src/chat/ChatRoot.tsx` — root container element gets `data-testid="vos-chat-root"`.

Future specs add their own ids (composer, message list, etc.). Convention rule in README: `data-testid="vos-<kebab-area>"`.

### 6. `plugin/package.json` + README

- Add devDep: `"@playwright/test": "^1.50.0"` (or current).
- Add script: `"e2e": "bunx playwright test --config e2e/playwright.config.ts"`.
- `plugin/e2e/README.md`: prereqs (macOS, Obsidian.app installed, bun), run (`bun run e2e` from `plugin/`), how to add a spec, fake-provider JSONL format + one example.

## Acceptance mapping (task file ↔ spec)

| Task acceptance bullet | Where satisfied |
|---|---|
| `plugin/e2e/` scaffold with Playwright config | §4 |
| Fixture vault with community-plugins.json + license-nag-skipped | §4 fixtures/vault |
| globalSetup spawns daemon + globalTeardown kills + settings points at port | §4 globalSetup/Teardown + §2 settings |
| Fake CC adapter via env override; no real Anthropic | §1 fake Provider impl; **task text said `VOS_CC_BIN`, decision pivoted to fake Provider impl driven by `VOS_PROVIDER=fake` + `VOS_FAKE_SCRIPT` (cleaner with VOS-86 abstraction). Task file gets a Decisions-section update reflecting this.** |
| Smoke `connect.spec.ts` passes locally | §4 connect.spec.ts |
| `pnpm e2e` wired | **Decision:** `bun run e2e` (plugin uses bun). Task acceptance bullet rephrased in mirror. |
| README in `plugin/e2e/` | §6 |
| `data-testid` convention for new + critical existing surfaces | §5 (scoped to status-bar + chat-root only; convention doc explicit about scope) |

## Risks / open questions

1. **Obsidian `--user-data-dir` flag** — confirmed standard Electron flag. If Obsidian's wrapper drops it, fall back to copying fixture vault into a temp location and pointing Obsidian's normal user-data dir env (`OBSIDIAN_USER_DATA` / per-platform path) at a temp.
3. **Playwright under bun** — `bunx playwright test` invokes Playwright's own runner (Node-based via shebang). `_electron.launch` is a Playwright API — runs in the runner process, not under bun. Expected to Just Work. Fallback: `npx playwright test` (devDep is identical).
4. **First-run modals** — pre-seeded `.obsidian/` flags should suppress; exact flag list TBD during impl by snapshotting a configured-once vault.
5. **Status-bar Obsidian API** — `addStatusBarItem()` returns an `HTMLElement`. Adding `data-testid` is a direct attribute set. Confirm `setText` doesn't wipe attributes (it sets `textContent`, leaves attrs intact).
6. **Free-port race** — gap between `listen(0).close()` and daemon `listen(port)` is small but real. Acceptable for v1. If flaky, switch to port-handoff (pass listener fd) later.

## Subtasks (preview for writing-plans)

1. Fake Provider impl + unit test
2. Provider factory env switch (`VOS_PROVIDER`) — new `daemon/src/providers/factory.ts`; rewire `app.ts`
3. Titler stub + `VOS_TITLER` env switch (auto-on when `VOS_PROVIDER=fake`)
4. Plugin `daemonUrl` setting + main.ts wiring + settings tab field
5. `data-testid` on `vos-status-bar` + `vos-chat-root`
6. `plugin/e2e/` scaffold (config, setup, teardown, helpers, fixtures, README)
7. `connect.spec.ts` + `package.json` script + devDep
8. Local run, capture pass; update task file Work Log

## Out of scope (explicit follow-ups, mint as separate tasks)

- chat round-trip spec
- cancel-mid-stream spec
- agent-picker spec (VOS-92 surface)
- reconnect-after-daemon-restart spec
- Linux CI (xvfb + AppImage)
- Real-Provider opt-in mode (env to flip back to claude-code for nightly run)
- Port-handoff hardening (eliminate listen(0).close → daemon.listen race; revisit before CI / real-provider nightly to remove TOCTOU risk)
