# VOS-93 Plugin e2e Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Playwright-Electron harness that boots real Obsidian + built plugin + isolated daemon with a deterministic fake Provider, plus one smoke spec proving the plugin connects.

**Architecture:** Daemon gains a provider-factory (`VOS_PROVIDER=fake` ⇒ new fake impl satisfying the `Provider` interface) and a titler stub (`VOS_TITLER=stub`) so e2e boots offline. Plugin gains a `daemonUrl` setting so the harness can point it at an isolated daemon on a free port. `plugin/e2e/` adds a Playwright runner with `globalSetup` that builds the plugin into a fixture vault, spawns the daemon, and connects via `_electron.launch` against `/Applications/Obsidian.app`.

**Tech Stack:** Bun, Hono, Playwright `@playwright/test` + `_electron`, React, Obsidian plugin API, SQLite. Tests live under `plugin/e2e/`. macOS-headed only for v1.

**Spec:** `docs/superpowers/specs/2026-05-15-vos-93-plugin-e2e-harness-design.md`
**Branch:** `task/VOS-93` in repo `void-os`. Commit after each task.

---

## File Structure

**New:**
- `daemon/src/providers/fake/index.ts` — fake Provider impl
- `daemon/src/providers/fake/__tests__/fake-provider.test.ts` — unit test
- `daemon/src/providers/factory.ts` — `makeProvider(env, deps)` dispatcher
- `daemon/src/providers/__tests__/factory.test.ts` — factory unit test
- `daemon/src/chat/titler-stub.ts` — no-op titler
- `plugin/src/config.ts` — exported timing constants (used by main + e2e)
- `plugin/src/settings-tab.ts` — Obsidian settings tab UI
- `plugin/e2e/playwright.config.ts`
- `plugin/e2e/globalSetup.ts`
- `plugin/e2e/globalTeardown.ts`
- `plugin/e2e/specs/connect.spec.ts`
- `plugin/e2e/fixtures/vault/welcome.md`
- `plugin/e2e/fixtures/vault/.obsidian/community-plugins.json`
- `plugin/e2e/fixtures/vault/.obsidian/app.json`
- `plugin/e2e/fixtures/vault/.obsidian/plugins/void-os/.gitkeep`
- `plugin/e2e/fixtures/cc/empty.jsonl`
- `plugin/e2e/README.md`
- `plugin/e2e/.gitignore` (ignore Playwright artifacts + per-run state files inside fixtures)

**Modified:**
- `daemon/src/providers/index.ts` — re-export factory
- `daemon/src/app.ts` — call `makeProvider(...)` instead of `makeClaudeCodeProviderComposed(...)`; titler stub branch
- `plugin/src/chat/settings.ts` — add `daemonUrl` to settings shape
- `plugin/src/main.ts` — derive DAEMON_HTTP/WS from settings; replace inline PING_MS/RETRY_MS with imports from `config.ts`; tag status-bar el with `data-testid`
- `plugin/src/status.ts` — unchanged code-wise (testid set at construction in main.ts)
- `plugin/src/chat/ChatRoot.tsx` — root element gets `data-testid="vos-chat-root"`
- `plugin/package.json` — `@playwright/test` devDep + `e2e` script

---

## Task 1: Fake Provider impl

**Files:**
- Create: `daemon/src/providers/fake/index.ts`
- Create: `daemon/src/providers/fake/__tests__/fake-provider.test.ts`
- Create test fixture: `daemon/src/providers/fake/__tests__/fixtures/two-events.jsonl`

- [ ] **Step 1.1: Write the failing unit test**

Create `daemon/src/providers/fake/__tests__/fake-provider.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { makeFakeProvider } from "../index.ts";

function tmpJsonl(lines: string[]): string {
  const p = path.join(os.tmpdir(), `fake-provider-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

describe("makeFakeProvider", () => {
  test("name is 'fake'", () => {
    const p = makeFakeProvider({ scriptPath: tmpJsonl([]) });
    expect(p.name).toBe("fake");
  });

  test("emits events parsed from JSONL then resolves done", async () => {
    const scriptPath = tmpJsonl([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);
    const provider = makeFakeProvider({ scriptPath });
    const handle = provider.spawn({ runId: "r1", prompt: "p", cwd: "/tmp" });
    const seen: string[] = [];
    for await (const ev of handle.events) seen.push(ev.type);
    expect(seen).toEqual(["system", "assistant"]);
    const result = await handle.done;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("s1");
  });

  test("cancel ends iteration with reason=cancel", async () => {
    const scriptPath = tmpJsonl([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "assistant", message: {} }),
    ]);
    const provider = makeFakeProvider({ scriptPath, perEventDelayMs: 50 });
    const handle = provider.spawn({ runId: "r2", prompt: "p", cwd: "/tmp" });
    const it = handle.events[Symbol.asyncIterator]();
    await it.next(); // pull first
    const cancelled = await handle.cancel();
    expect(cancelled).toBe(true);
    // drain
    while (!(await it.next()).done) {}
    const result = await handle.done;
    expect(result.reason).toBe("cancel");
  });

  test("missing script ⇒ done resolves reason=error", async () => {
    const provider = makeFakeProvider({ scriptPath: "/tmp/does-not-exist-vos93.jsonl" });
    const handle = provider.spawn({ runId: "r3", prompt: "p", cwd: "/tmp" });
    for await (const _ of handle.events) {}
    const result = await handle.done;
    expect(result.reason).toBe("error");
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd /Users/admin/void-os/daemon && bun test src/providers/fake/__tests__/fake-provider.test.ts`
Expected: FAIL — `Cannot find module '../index.ts'`.

- [ ] **Step 1.3: Implement fake provider**

Create `daemon/src/providers/fake/index.ts`:

```ts
/**
 * Fake Provider — deterministic event-stream replayer for e2e tests.
 *
 * Reads JSONL from `scriptPath`. Each line is parsed as a ProviderEvent and
 * yielded in order. No child process. No network. No SDK. Used by `plugin/e2e/`
 * when `VOS_PROVIDER=fake` is set (selected by the provider factory).
 */
import { readFile } from "node:fs/promises";
import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../types.ts";

export interface FakeProviderOpts {
  scriptPath: string;
  /** Optional delay between events. Default 0. Useful for cancel tests. */
  perEventDelayMs?: number;
}

export function makeFakeProvider(opts: FakeProviderOpts): Provider {
  const scriptPath = opts.scriptPath;
  const perEventDelayMs = opts.perEventDelayMs ?? 0;
  return {
    name: "fake",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let cancelled = false;
      let resolveDone!: (r: { exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }) => void;
      const done = new Promise<{ exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }>((res) => {
        resolveDone = res;
      });
      let sessionId: string | undefined;

      async function* gen(): AsyncGenerator<ProviderEvent> {
        let raw: string;
        try {
          raw = await readFile(scriptPath, "utf8");
        } catch (err) {
          resolveDone({ reason: "error" });
          return;
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          if (cancelled) { resolveDone({ reason: "cancel" }); return; }
          let ev: ProviderEvent;
          try { ev = JSON.parse(line) as ProviderEvent; }
          catch { resolveDone({ reason: "error" }); return; }
          if (ev.type === "system" && typeof ev.session_id === "string") {
            sessionId = ev.session_id;
          }
          yield ev;
          if (perEventDelayMs > 0) await new Promise((r) => setTimeout(r, perEventDelayMs));
        }
        resolveDone({ reason: "exit", exitCode: 0, sessionId });
      }

      return {
        events: gen(),
        async cancel() {
          if (cancelled) return false;
          cancelled = true;
          return true;
        },
        done,
      };
    },
  };
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `cd /Users/admin/void-os/daemon && bun test src/providers/fake/__tests__/fake-provider.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/admin/void-os
git add daemon/src/providers/fake/
git commit -m "feat(VOS-93): fake Provider impl + unit tests"
```

---

## Task 2: Provider factory env switch

**Files:**
- Create: `daemon/src/providers/factory.ts`
- Create: `daemon/src/providers/__tests__/factory.test.ts`
- Modify: `daemon/src/providers/index.ts` — re-export factory
- Modify: `daemon/src/app.ts` — call `makeProvider(...)`

- [ ] **Step 2.1: Write the failing factory test**

Create `daemon/src/providers/__tests__/factory.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { makeProvider } from "../factory.ts";

function tmpJsonl(): string {
  const p = path.join(os.tmpdir(), `factory-${Date.now()}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: "system", session_id: "s" }) + "\n");
  return p;
}

describe("makeProvider", () => {
  test("default ⇒ claude-code", () => {
    const p = makeProvider({}, fakeDeps());
    expect(p.name).toBe("claude-code");
  });

  test("VOS_PROVIDER=fake ⇒ fake", () => {
    const p = makeProvider(
      { VOS_PROVIDER: "fake", VOS_FAKE_SCRIPT: tmpJsonl() },
      fakeDeps(),
    );
    expect(p.name).toBe("fake");
  });

  test("VOS_PROVIDER=fake with missing VOS_FAKE_SCRIPT ⇒ throws", () => {
    expect(() => makeProvider({ VOS_PROVIDER: "fake" }, fakeDeps())).toThrow(
      /VOS_FAKE_SCRIPT/,
    );
  });

  test("unknown VOS_PROVIDER ⇒ throws", () => {
    expect(() => makeProvider({ VOS_PROVIDER: "weird" }, fakeDeps())).toThrow(
      /unknown provider/,
    );
  });
});

function fakeDeps() {
  // Minimal deps — claude-code path won't actually spawn anything inside this
  // test because we only assert `.name`. We still need the shape to satisfy
  // makeClaudeCodeProviderComposed's signature.
  return {
    bus: { emit: () => {}, subscribe: () => () => {} } as any,
    db: {} as any,
    tracesDir: "/tmp/traces",
    agent: "maya",
    cwd: "/tmp",
  };
}
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd /Users/admin/void-os/daemon && bun test src/providers/__tests__/factory.test.ts`
Expected: FAIL — `Cannot find module '../factory.ts'`.

- [ ] **Step 2.3: Implement factory**

Create `daemon/src/providers/factory.ts`:

```ts
/**
 * Provider factory — dispatches on VOS_PROVIDER env.
 *
 * Default: "claude-code" (production). e2e sets "fake".
 */
import type { Provider } from "./types.ts";
import { makeClaudeCodeProviderComposed } from "./claude-code/index.ts";
import { makeFakeProvider } from "./fake/index.ts";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";

export interface ProviderEnv {
  VOS_PROVIDER?: string;
  VOS_FAKE_SCRIPT?: string;
}

export interface ProviderDeps {
  bus: EventBus;
  db: Database;
  tracesDir: string;
  agent: string;
  cwd: string;
}

export function makeProvider(env: ProviderEnv, deps: ProviderDeps): Provider {
  const kind = env.VOS_PROVIDER ?? "claude-code";
  if (kind === "claude-code") {
    return makeClaudeCodeProviderComposed({
      bus: deps.bus,
      db: deps.db,
      tracesDir: deps.tracesDir,
      agent: deps.agent,
      cwd: deps.cwd,
    });
  }
  if (kind === "fake") {
    const scriptPath = env.VOS_FAKE_SCRIPT;
    if (!scriptPath) {
      throw new Error("VOS_PROVIDER=fake requires VOS_FAKE_SCRIPT env var");
    }
    return makeFakeProvider({ scriptPath });
  }
  throw new Error(`unknown provider: ${kind}`);
}
```

- [ ] **Step 2.4: Re-export from providers/index.ts**

Edit `daemon/src/providers/index.ts` — append:

```ts
export { makeProvider } from "./factory.ts";
export type { ProviderEnv, ProviderDeps } from "./factory.ts";
```

- [ ] **Step 2.5: Run factory test**

Run: `cd /Users/admin/void-os/daemon && bun test src/providers/__tests__/factory.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 2.6: Rewire app.ts**

Edit `daemon/src/app.ts`. Replace these two lines in the import block:

```ts
import { makeClaudeCodeProviderComposed } from "./providers/claude-code/index.ts";
```

with:

```ts
import { makeProvider } from "./providers/factory.ts";
```

Then locate the orchestrator-build block (around lines 78–90, inside `if (!orchestrator) { ... }`). Replace:

```ts
const provider = makeClaudeCodeProviderComposed({
  bus,
  db: deps.db,
  tracesDir,
  agent: deps.defaultAgent ?? "maya",
  cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
});
```

with:

```ts
const provider = makeProvider(process.env, {
  bus,
  db: deps.db,
  tracesDir,
  agent: deps.defaultAgent ?? "maya",
  cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
});
```

- [ ] **Step 2.7: Run full daemon test suite to confirm no regression**

Run: `cd /Users/admin/void-os/daemon && bun test`
Expected: PASS — all daemon tests including new factory + fake.

- [ ] **Step 2.8: Commit**

```bash
cd /Users/admin/void-os
git add daemon/src/providers/factory.ts daemon/src/providers/__tests__/ daemon/src/providers/index.ts daemon/src/app.ts
git commit -m "feat(VOS-93): provider factory dispatch on VOS_PROVIDER env"
```

---

## Task 3: Titler stub + VOS_TITLER env switch

**Files:**
- Create: `daemon/src/chat/titler-stub.ts`
- Modify: `daemon/src/app.ts` — short-circuit titler when `VOS_TITLER=stub` or `VOS_PROVIDER=fake`

- [ ] **Step 3.1: Inspect existing Titler interface**

Read `daemon/src/chat/titler.ts` lines around `export interface Titler` (~line 48) to capture method signatures the stub must satisfy. This is the only "context check" step; no code change.

- [ ] **Step 3.2: Write the failing test**

Create `daemon/src/chat/__tests__/titler-stub.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { makeTitlerStub } from "../titler-stub.ts";

describe("makeTitlerStub", () => {
  test("returns a Titler whose methods resolve no-op", async () => {
    const t = makeTitlerStub();
    // The exact method names are taken from `Titler` interface. Today
    // (VOS-79) the only method is `maybeTitle(chatId)`. If the interface
    // grows, this test forces the stub to keep up.
    const result = await t.maybeTitle("c1");
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 3.3: Run test, expect fail**

Run: `cd /Users/admin/void-os/daemon && bun test src/chat/__tests__/titler-stub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.4: Implement stub**

Create `daemon/src/chat/titler-stub.ts`. Use the Titler interface exactly as in `titler.ts` — if it has more methods than `maybeTitle`, stub all of them to no-ops. Reference implementation:

```ts
/**
 * No-op Titler — used in e2e and offline boot when VOS_TITLER=stub.
 * Conforms to `Titler` interface; every method returns synchronously
 * without touching the network or the chat-titles table.
 */
import type { Titler } from "./titler.ts";

export function makeTitlerStub(): Titler {
  return {
    async maybeTitle(_chatId: string): Promise<void> {
      // intentionally empty
    },
  };
}
```

If the `Titler` interface declares additional methods, add matching no-op implementations (`async () => undefined`).

- [ ] **Step 3.5: Run test, expect pass**

Run: `cd /Users/admin/void-os/daemon && bun test src/chat/__tests__/titler-stub.test.ts`
Expected: PASS.

- [ ] **Step 3.6: Wire env switch in app.ts**

Edit `daemon/src/app.ts`. Add import near the other chat imports:

```ts
import { makeTitlerStub } from "./chat/titler-stub.ts";
```

Inside the titler-build block (`if (!titler) { ... }`, around lines 73–76), replace:

```ts
if (!titler) {
  const sdk = await buildAnthropicSdk();
  titler = makeTitler({ repo, sdk, replay, emit });
}
```

with:

```ts
if (!titler) {
  const useStub =
    process.env.VOS_TITLER === "stub" ||
    (process.env.VOS_TITLER == null && process.env.VOS_PROVIDER === "fake");
  if (useStub) {
    titler = makeTitlerStub();
  } else {
    const sdk = await buildAnthropicSdk();
    titler = makeTitler({ repo, sdk, replay, emit });
  }
}
```

- [ ] **Step 3.7: Run full daemon test suite**

Run: `cd /Users/admin/void-os/daemon && bun test`
Expected: PASS — no regression.

- [ ] **Step 3.8: Smoke-boot daemon with VOS_PROVIDER=fake + no Anthropic env**

Run (manual smoke — does NOT need to stay in CI):

```bash
cd /Users/admin/void-os/daemon
mkdir -p /tmp/vos93-smoke-vault
echo '{"type":"system","subtype":"init","session_id":"smoke"}' > /tmp/vos93-smoke.jsonl
VOID_OS_PORT=17777 VOID_OS_DB=/tmp/vos93-smoke.sqlite \
  VOID_OS_VAULT_ROOT=/tmp/vos93-smoke-vault \
  VOS_PROVIDER=fake VOS_FAKE_SCRIPT=/tmp/vos93-smoke.jsonl \
  unset ANTHROPIC_API_KEY; unset VOID_KEYS_URL; \
  timeout 5 bun run src/index.ts || true
```

Expected: daemon logs `listening on http://127.0.0.1:17777` within 2s, no Anthropic-key fetch, no error. Then timeout kills it cleanly.

If it hangs or errors with an Anthropic-key message, the stub wiring is incomplete — go back to step 3.6.

- [ ] **Step 3.9: Commit**

```bash
cd /Users/admin/void-os
git add daemon/src/chat/titler-stub.ts daemon/src/chat/__tests__/titler-stub.test.ts daemon/src/app.ts
git commit -m "feat(VOS-93): titler stub + VOS_TITLER=stub env switch"
```

---

## Task 4: Plugin `daemonUrl` setting + settings tab

**Files:**
- Modify: `plugin/src/chat/settings.ts` — add `daemonUrl` field
- Modify: `plugin/src/main.ts` — derive DAEMON_HTTP/DAEMON_WS from settings; add settings tab
- Create: `plugin/src/settings-tab.ts` — Obsidian `PluginSettingTab`
- Modify: `plugin/test/settings.test.ts` (or create `settings-daemon-url.test.ts`) — assert default + load behavior

- [ ] **Step 4.1: Write the failing settings test**

Create `plugin/test/settings-daemon-url.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { makeSettingsStore, DEFAULT_SETTINGS } from "../src/chat/settings.ts";

describe("settings.daemonUrl", () => {
  test("default is undefined (caller falls back to localhost)", () => {
    expect(DEFAULT_SETTINGS.daemonUrl).toBeUndefined();
  });

  test("loaded value is preserved", async () => {
    const io = {
      loadData: async () => ({ daemonUrl: "http://127.0.0.1:17777" }),
      saveData: async () => {},
    };
    const store = await makeSettingsStore(io);
    expect(store.get().daemonUrl).toBe("http://127.0.0.1:17777");
  });
});
```

- [ ] **Step 4.2: Run test, expect fail**

Run: `cd /Users/admin/void-os/plugin && bun test test/settings-daemon-url.test.ts`
Expected: FAIL — `daemonUrl` not on `VoidOsSettings` type / value missing.

- [ ] **Step 4.3: Add field to settings.ts**

Edit `plugin/src/chat/settings.ts`. Update the interface + defaults:

```ts
export interface VoidOsSettings {
  chatId: string | null;
  daemonUrl?: string;
}

export const DEFAULT_SETTINGS: VoidOsSettings = {
  chatId: null,
  // daemonUrl omitted on purpose: undefined ⇒ caller uses built-in default
};
```

Also extend `SettingsStore` with a setter for `daemonUrl`:

```ts
export interface SettingsStore {
  get(): VoidOsSettings;
  setChatId(id: string): Promise<void>;
  setDaemonUrl(url: string | undefined): Promise<void>;
}
```

And implement it inside `makeSettingsStore`:

```ts
async setDaemonUrl(url: string | undefined) {
  current = { ...current, daemonUrl: url };
  await io.saveData(current);
},
```

- [ ] **Step 4.4: Run test, expect pass**

Run: `cd /Users/admin/void-os/plugin && bun test test/settings-daemon-url.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 4.5: Replace hardcoded URLs in main.ts**

Edit `plugin/src/main.ts`. Locate (around line 52):

```ts
const DAEMON_HTTP = "http://127.0.0.1:7777";
const DAEMON_WS = "ws://127.0.0.1:7777/events";
```

Replace with a helper + use it inside `onload()` after `this.settings` is created. New shape:

```ts
const DEFAULT_DAEMON_HTTP = "http://127.0.0.1:7777";

function deriveDaemonUrls(settings: { daemonUrl?: string }): { http: string; ws: string } {
  const http = settings.daemonUrl?.trim() || DEFAULT_DAEMON_HTTP;
  // ws derives from http: http://host:port ⇒ ws://host:port/events
  const ws = http.replace(/^http/i, "ws").replace(/\/+$/, "") + "/events";
  return { http, ws };
}
```

Then anywhere `DAEMON_HTTP` / `DAEMON_WS` were used (e.g. constructing `WsClient`, `ChatApi`), replace with `urls.http` / `urls.ws` where `urls = deriveDaemonUrls(this.settings.get())` is computed at the start of `onload()` (after `this.settings = await makeSettingsStore(...)`).

- [ ] **Step 4.6: Implement settings tab**

Create `plugin/src/settings-tab.ts`:

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingsStore } from "./chat/settings.ts";

export class VoidOsSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: { settings: SettingsStore }) {
    super(app, plugin as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "void-os" });

    new Setting(containerEl)
      .setName("Daemon URL")
      .setDesc("HTTP origin of the void-os daemon. Leave blank for http://127.0.0.1:7777.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:7777")
          .setValue(this.plugin.settings.get().daemonUrl ?? "")
          .onChange(async (value) => {
            await this.plugin.settings.setDaemonUrl(value.trim() || undefined);
          }),
      );
  }
}
```

- [ ] **Step 4.7: Register settings tab in main.ts**

In `plugin/src/main.ts` `onload()`, after `this.settings = await makeSettingsStore(...)`, add:

```ts
this.addSettingTab(new VoidOsSettingsTab(this.app, this));
```

And add the import at the top of the file:

```ts
import { VoidOsSettingsTab } from "./settings-tab.ts";
```

The `plugin` argument shape required by `addSettingTab` is `Plugin`. `this` already extends `Plugin` so just pass `this`. (Update the `VoidOsSettingsTab` constructor's second-arg type from the test-friendly `{ settings: SettingsStore }` to `VoidOsPlugin` if convenient; keep `{ settings: SettingsStore }` if it works under TypeScript's structural typing without errors.)

- [ ] **Step 4.8: Run plugin test suite**

Run: `cd /Users/admin/void-os/plugin && bun test`
Expected: PASS — all existing 61 tests + new 2.

- [ ] **Step 4.9: Build plugin to confirm no TS errors**

Run: `cd /Users/admin/void-os/plugin && bun run build`
Expected: build completes; logs `built → …/void-os`. No TypeScript error spam.

- [ ] **Step 4.10: Commit**

```bash
cd /Users/admin/void-os
git add plugin/src/chat/settings.ts plugin/src/settings-tab.ts plugin/src/main.ts plugin/test/settings-daemon-url.test.ts
git commit -m "feat(VOS-93): plugin daemonUrl setting + settings tab"
```

---

## Task 5: data-testid + plugin/src/config.ts

**Files:**
- Create: `plugin/src/config.ts`
- Modify: `plugin/src/main.ts` — import constants from `config.ts`; tag status-bar el
- Modify: `plugin/src/chat/ChatRoot.tsx` — root element gets `data-testid="vos-chat-root"`

- [ ] **Step 5.1: Create config.ts**

Create `plugin/src/config.ts`:

```ts
/**
 * Plugin-wide timing constants. Exported so e2e specs can import the same
 * values without duplicating literals.
 */
export const DEFAULT_RETRY_MS = 2_000;
export const DEFAULT_PING_MS = 10_000;
export const DEFAULT_PONG_TIMEOUT_MS = 25_000;
```

- [ ] **Step 5.2: Replace literals in main.ts with imports**

Edit `plugin/src/main.ts`. Remove the existing trio:

```ts
const RETRY_MS = 2000;
const PING_MS = 10000;
const PONG_TIMEOUT_MS = 25000;
```

Add import at the top:

```ts
import { DEFAULT_RETRY_MS, DEFAULT_PING_MS, DEFAULT_PONG_TIMEOUT_MS } from "./config.ts";
```

Update the FSM construction site (around line 110) to use the imports:

```ts
this.fsm = new ReconnectFSM({
  client: tappedClient,
  onState: (s) => statusBar.update(s),
  retryMs: DEFAULT_RETRY_MS,
  pingMs: DEFAULT_PING_MS,
  pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
});
```

- [ ] **Step 5.3: Tag status bar element**

Edit `plugin/src/main.ts`. Locate (around line 109):

```ts
const statusBar = new StatusBar(this.addStatusBarItem());
```

Replace with:

```ts
const statusBarEl = this.addStatusBarItem();
statusBarEl.setAttribute("data-testid", "vos-status-bar");
const statusBar = new StatusBar(statusBarEl);
```

- [ ] **Step 5.4: Tag ChatRoot**

Edit `plugin/src/chat/ChatRoot.tsx`. Find the root JSX element returned from `ChatRoot` (the outer-most element after the hook setup, likely a `<div>` or `<AssistantRuntimeProvider>` wrapper). Add `data-testid="vos-chat-root"` to it. If the root is `<AssistantRuntimeProvider>` which doesn't accept arbitrary HTML attrs, wrap the inner content in a `<div data-testid="vos-chat-root" className="...">` block.

Concretely: open the file, scan from `export function ChatRoot` downward to the first `return (` statement, and add the attribute to the outermost rendered element. If that element is a non-DOM Provider component, wrap its children in a `<div data-testid="vos-chat-root">`.

- [ ] **Step 5.5: Build plugin to confirm no TS errors**

Run: `cd /Users/admin/void-os/plugin && bun run build`
Expected: builds clean.

- [ ] **Step 5.6: Run existing unit tests**

Run: `cd /Users/admin/void-os/plugin && bun test`
Expected: PASS — all tests unaffected (testid is additive).

- [ ] **Step 5.7: Commit**

```bash
cd /Users/admin/void-os
git add plugin/src/config.ts plugin/src/main.ts plugin/src/chat/ChatRoot.tsx
git commit -m "feat(VOS-93): plugin config.ts + data-testid on status-bar + chat-root"
```

---

## Task 6: e2e scaffold (config, setup, teardown, fixtures, README)

**Files:** all under `plugin/e2e/` (new directory)

- [ ] **Step 6.1: Add Playwright devDep + e2e script**

Edit `plugin/package.json`. In `devDependencies` add:

```json
"@playwright/test": "^1.50.0"
```

In `scripts` add:

```json
"e2e": "bunx playwright test --config e2e/playwright.config.ts"
```

Then run install: `cd /Users/admin/void-os/plugin && bun install`
Expected: lockfile updates; Playwright installed.

Install Playwright's browser binaries (Electron is bundled with Playwright so no extra download is strictly required, but run this to make sure Playwright's bookkeeping is sane): `cd /Users/admin/void-os/plugin && bunx playwright install --with-deps chromium` — if this errors due to bun-vs-node, fall back to `npx playwright install chromium`. Browser install is one-time.

- [ ] **Step 6.2: Create fixture vault directory tree**

Create the following files (commit empty/placeholder content):

`plugin/e2e/fixtures/vault/welcome.md`:

```
# void-os e2e fixture vault

This vault exists only to host the void-os plugin during Playwright runs.
```

`plugin/e2e/fixtures/vault/.obsidian/community-plugins.json`:

```json
["void-os"]
```

`plugin/e2e/fixtures/vault/.obsidian/app.json`:

```json
{
  "promptDelete": false,
  "alwaysUpdateLinks": false,
  "newFileLocation": "root",
  "showUnsupportedFiles": false
}
```

(`app.json` keys that suppress first-run nags are best-effort; if Playwright runs surface unexpected modals, snapshot a configured-once vault later and replace this file with the snapshotted copy. Track as a follow-up issue if it bites.)

`plugin/e2e/fixtures/vault/.obsidian/plugins/void-os/.gitkeep` — empty file (build output goes here at setup time; we ship `.gitkeep` so the directory exists in git).

`plugin/e2e/fixtures/cc/empty.jsonl`:

```
{"type":"system","subtype":"init","session_id":"e2e-smoke"}
```

- [ ] **Step 6.3: Create `.gitignore` inside `plugin/e2e/`**

Create `plugin/e2e/.gitignore`:

```
# Per-run build output written by globalSetup.
fixtures/vault/.obsidian/plugins/void-os/*
!fixtures/vault/.obsidian/plugins/void-os/.gitkeep

# Per-run resolved settings.
fixtures/vault/.obsidian/plugins/void-os/data.json

# Playwright artifacts.
playwright-report/
test-results/
```

- [ ] **Step 6.4: Create playwright.config.ts**

Create `plugin/e2e/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
import * as path from "node:path";

export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),
  use: {
    headless: false,
  },
});
```

- [ ] **Step 6.5: Create globalSetup.ts**

Create `plugin/e2e/globalSetup.ts`:

```ts
/**
 * Playwright globalSetup for void-os e2e.
 *
 * Sequence:
 *   1. Pick a free port.
 *   2. Build the plugin into the fixture vault.
 *   3. Write resolved settings (daemonUrl) into the fixture plugin dir.
 *   4. Spawn the daemon with isolated env (fake provider, stub titler, tmp DB,
 *      tmp vault root).
 *   5. Poll daemon for readiness.
 *   6. Persist state to a sidecar JSON file so the spec + teardown can read it.
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DAEMON_ROOT = path.resolve(HERE, "..", "..", "daemon");
const VAULT_PATH = path.join(HERE, "fixtures", "vault");
const PLUGIN_OUT = path.join(VAULT_PATH, ".obsidian", "plugins", "void-os");
const FAKE_SCRIPT = path.join(HERE, "fixtures", "cc", "empty.jsonl");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("freePort: address() returned non-object"));
      }
    });
  });
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return;
    } catch { /* connection refused — keep trying */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become ready on :${port} within ${timeoutMs}ms`);
}

export default async function globalSetup() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "void-os-e2e-"));
  const daemonVault = path.join(tmpdir, "vault");
  const dbPath = path.join(tmpdir, "state.sqlite");
  const obsidianUserDataDir = path.join(tmpdir, "obsidian-user-data");
  fs.mkdirSync(daemonVault, { recursive: true });
  fs.mkdirSync(obsidianUserDataDir, { recursive: true });

  const port = await freePort();

  // Build plugin into fixture vault.
  const build = spawnSync("bun", ["run", "build.ts"], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, VOID_OS_PLUGIN_OUT: PLUGIN_OUT },
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`plugin build failed: exit ${build.status}`);
  }

  // Write resolved data.json.
  fs.writeFileSync(
    path.join(PLUGIN_OUT, "data.json"),
    JSON.stringify({ daemonUrl: `http://127.0.0.1:${port}` }, null, 2),
  );

  // Spawn daemon.
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    VOID_OS_PORT: String(port),
    VOID_OS_HOST: "127.0.0.1",
    VOID_OS_DB: dbPath,
    VOID_OS_VAULT_ROOT: daemonVault,
    VOS_PROVIDER: "fake",
    VOS_TITLER: "stub",
    VOS_FAKE_SCRIPT: FAKE_SCRIPT,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.VOID_KEYS_URL;

  const daemon: ChildProcess = spawn("bun", ["run", "src/index.ts"], {
    cwd: DAEMON_ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });

  // Wait for readiness.
  try {
    await waitForReady(port, 10_000);
  } catch (err) {
    daemon.kill("SIGKILL");
    throw err;
  }

  const state = {
    port,
    daemonPid: daemon.pid,
    tmpdir,
    vaultPath: VAULT_PATH,
    obsidianUserDataDir,
  };
  const statePath = path.join(tmpdir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env.VOS_E2E_STATE = statePath;
}
```

- [ ] **Step 6.6: Create globalTeardown.ts**

Create `plugin/e2e/globalTeardown.ts`:

```ts
import * as fs from "node:fs";

export default async function globalTeardown() {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath || !fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    daemonPid: number;
    tmpdir: string;
  };
  try { process.kill(state.daemonPid, "SIGTERM"); } catch { /* already gone */ }
  // Give SIGTERM 2s before SIGKILL.
  await new Promise((r) => setTimeout(r, 2_000));
  try { process.kill(state.daemonPid, 0); process.kill(state.daemonPid, "SIGKILL"); } catch { /* gone */ }
  try { fs.rmSync(state.tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
```

- [ ] **Step 6.7: Create README**

Create `plugin/e2e/README.md`:

```markdown
# plugin/e2e — Playwright Electron + fake-Provider harness

End-to-end tests booting real Obsidian + built plugin + isolated void-os daemon.

## Prereqs

- macOS (v1 is macOS-headed only)
- Obsidian installed at `/Applications/Obsidian.app`
- bun (this repo's package manager)

## Run

```bash
cd plugin
bun run e2e
```

`globalSetup` builds the plugin into `plugin/e2e/fixtures/vault/.obsidian/plugins/void-os/`, picks a free port, spawns the daemon with `VOS_PROVIDER=fake` + `VOS_TITLER=stub` + tmpdir DB/vault, and writes per-run state to `<tmpdir>/state.json`. `globalTeardown` SIGTERMs the daemon and removes the tmpdir.

## Add a spec

Create `plugin/e2e/specs/<name>.spec.ts`:

```ts
import { test, expect, _electron as electron } from "@playwright/test";
import { readFileSync } from "node:fs";

test("...", async () => {
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8"));
  const app = await electron.launch({
    executablePath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    args: [`--user-data-dir=${state.obsidianUserDataDir}`, state.vaultPath],
  });
  const win = await app.firstWindow();
  // ...
  await app.close();
});
```

## Fake-Provider JSONL format

Each line is one `ProviderEvent` (see `daemon/src/providers/types.ts`). The empty-stream fixture (`fixtures/cc/empty.jsonl`) contains a single system init event.

Example chat round-trip canned stream:

```jsonl
{"type":"system","subtype":"init","session_id":"e2e"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}
```

## data-testid convention

`data-testid="vos-<kebab-area>"`. v1 ships two: `vos-status-bar`, `vos-chat-root`. Per-spec tasks add more as needed.

## Known limitations (v1)

- macOS-headed only. Linux/CI deferred.
- One spec per run (workers: 1) — Electron + Obsidian don't tolerate parallel instances.
- Free-port → daemon-listen has a small TOCTOU window. Acceptable on a dev workstation; revisit before CI.
```

- [ ] **Step 6.8: Type-check the scaffold (no test run yet)**

The Playwright config files are TypeScript. Just confirm Playwright's runner can load them:

Run: `cd /Users/admin/void-os/plugin && bunx playwright test --list --config e2e/playwright.config.ts`
Expected: lists 0 tests (specs dir is empty until Task 7). No TS errors.

- [ ] **Step 6.9: Commit**

```bash
cd /Users/admin/void-os
git add plugin/package.json plugin/bun.lock plugin/e2e/
git commit -m "feat(VOS-93): plugin/e2e/ scaffold — Playwright config, globalSetup, fixtures"
```

---

## Task 7: connect smoke spec

**Files:**
- Create: `plugin/e2e/specs/connect.spec.ts`

- [ ] **Step 7.1: Write the smoke spec**

Create `plugin/e2e/specs/connect.spec.ts`:

```ts
import { test, expect, _electron as electron } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_PING_MS } from "../../src/config.ts";

test("plugin boots and reaches connected state, sustained across one heartbeat", async () => {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    port: number;
    vaultPath: string;
    obsidianUserDataDir: string;
  };

  const app = await electron.launch({
    executablePath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    args: [
      `--user-data-dir=${state.obsidianUserDataDir}`,
      state.vaultPath,
    ],
  });

  try {
    const win = await app.firstWindow();
    const pill = win.getByTestId("vos-status-bar");
    // Initial connect: WS open + hello frame ⇒ FSM transitions to "connected".
    await expect(pill).toHaveText("void-os: connected", { timeout: 15_000 });
    // Heartbeat proof: still connected after one ping cycle.
    await win.waitForTimeout(DEFAULT_PING_MS + 2_000);
    await expect(pill).toHaveText("void-os: connected");
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 7.2: First run — likely fails the first time**

Run: `cd /Users/admin/void-os/plugin && bun run e2e`

Expected on a clean machine: globalSetup succeeds, Obsidian launches, status bar reaches "void-os: connected" within 15s, second assertion passes after 12s. Total run ≈ 25–30s.

Common first-run failures:
1. **Obsidian first-launch modal blocks rendering** — vault prompt or license nag. Fix by adding more keys to `fixtures/vault/.obsidian/app.json` (snapshot a hand-configured vault).
2. **`--user-data-dir` ignored by Obsidian** — fall back to launching with default user-data and rely on the fixture vault path being recognized as a fresh vault. If still broken, swap `_electron.launch` args to `executablePath` + `args: [state.vaultPath]` only.
3. **`bunx playwright test` errors on _electron** — fall back to `npx playwright test --config e2e/playwright.config.ts`. Both runners install from the same `@playwright/test` devDep.
4. **Daemon never reached "ready"** — check `VOID_OS_VAULT_ROOT` exists; daemon exits 2 if not. globalSetup creates it but verify the spawn env.
5. **Status bar never hits "connected"** — open Obsidian's devtools (Ctrl+Shift+I inside the launched window — Playwright lets you `await app.firstWindow(); await win.evaluate(...)` to debug) and check the WsClient logs.

Iterate until the spec passes. Each failure mode above gets a one-line fix; none requires re-architecture.

- [ ] **Step 7.3: Run twice in a row to confirm stability**

Run: `cd /Users/admin/void-os/plugin && bun run e2e && bun run e2e`
Expected: PASS both times.

- [ ] **Step 7.4: Commit**

```bash
cd /Users/admin/void-os
git add plugin/e2e/specs/connect.spec.ts
# If e2e iteration required fixture/setup tweaks, include those too:
git add plugin/e2e/
git commit -m "test(VOS-93): connect smoke spec — plugin reaches connected + heartbeat"
```

---

## Task 8: Update task file + push branch

**Files:**
- Modify (via hub `sw`): `/Users/admin/hub/vault/work/tasks/active/VOS-93-plugin-e2e-harness-playwright-electron.md`

- [ ] **Step 8.1: Tick acceptance bullets in the hub task file**

From the hub canonical (`/Users/admin/hub`), use `tools/state-write/sw` to mark all 8 acceptance checkboxes `[x]`, mirror plan into the task file's `## Plan` section (one-line pointer to this plan doc), and append a Work Log entry summarizing the session.

Concrete command from `/Users/admin/hub`:

```bash
tools/state-write/sw "task(VOS-93): plan committed + acceptance ticked" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-93-*.md | head -1)
  # Replace Plan section body.
  python3 - "$f" <<PY
import sys, re
p = sys.argv[1]
src = open(p, encoding="utf-8").read()
plan_body = "Plan: see /Users/admin/void-os/docs/superpowers/plans/2026-05-15-vos-93-plugin-e2e-harness.md\n"
src = re.sub(r"(?ms)(^## Plan\s*\n).*?(?=^## )", r"\1" + plan_body + "\n", src)
# Subtasks block.
subtasks = """- [ ] T1 Fake Provider impl + unit test
- [ ] T2 Provider factory env switch
- [ ] T3 Titler stub + VOS_TITLER env switch
- [ ] T4 Plugin daemonUrl setting + settings tab
- [ ] T5 data-testid + plugin/src/config.ts
- [ ] T6 plugin/e2e/ scaffold
- [ ] T7 connect smoke spec
- [ ] T8 Update task file + push branch
"""
src = re.sub(r"(?ms)(^## Subtasks\s*\n).*?(?=^## )", r"\1" + subtasks + "\n", src)
open(p, "w", encoding="utf-8").write(src)
PY
  git add "$f"
'
```

(If `mirror-plan.py` exists at `tools/work-plan/mirror-plan.py`, prefer it. Otherwise the inline `python3 -` above is correct.)

- [ ] **Step 8.2: Append final Work Log entry**

```bash
tools/state-write/sw "task(VOS-93): work-log session 1 close" -- bash -c '
  set -e
  cd /Users/admin/hub
  f=$(ls vault/work/tasks/active/VOS-93-*.md | head -1)
  cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · session 1 close
- Plan written + forge-reviewed; spec at /Users/admin/void-os/docs/superpowers/specs/2026-05-15-vos-93-plugin-e2e-harness-design.md
- All 8 tasks implemented; e2e smoke green twice in a row
- void-os branch task/VOS-93 ready for review
EOF
  git add "$f"
'
```

- [ ] **Step 8.3: Push void-os branch**

```bash
cd /Users/admin/void-os
git push -u origin task/VOS-93
```

Expected: branch published. Do NOT open the PR yet — `/done` handles merge for external repos.

- [ ] **Step 8.4: Final verification batch**

Run all of these and confirm each passes:

```bash
# daemon tests
cd /Users/admin/void-os/daemon && bun test

# plugin unit tests
cd /Users/admin/void-os/plugin && bun test

# plugin build
cd /Users/admin/void-os/plugin && bun run build

# e2e smoke
cd /Users/admin/void-os/plugin && bun run e2e
```

Expected: all green.

- [ ] **Step 8.5: Prompt operator for /done**

Print to the operator:

```
VOS-93 complete. To finish:
  /done VOS-93
```

`/done` will merge `task/VOS-93` to `main` in `void-os`, push, and move the hub task file to `completed/`.

---

## Acceptance mapping (spec ↔ tasks)

| Spec component | Tasks |
|---|---|
| §1 Fake Provider impl | T1 |
| §1.5 Titler stub | T3 |
| §2 Plugin `daemonUrl` setting | T4 |
| §3 Daemon isolation env vars | T6 globalSetup (no daemon patch) |
| §4 e2e harness | T6 (+ T7 spec) |
| §4 Provider factory wiring | T2 |
| §5 data-testid | T5 |
| §6 package.json script + README | T6 |

## Risks called out in spec — addressed where

1. Obsidian `--user-data-dir` flag — handled inline at Step 7.2 (fallback path documented).
2. Playwright under bun — handled inline at Step 7.2 (`npx` fallback).
3. First-run modals — handled inline at Step 7.2 (snapshot vault if needed).
4. Status-bar Obsidian API — verified: `addStatusBarItem()` returns an `HTMLElement`, `setText` sets `textContent` (attrs preserved). Step 5.3 sets the attr at construction time.
5. Free-port race — accepted for v1 (see follow-up in spec).
