# VOS-116 — Daemon HTTP API for CLI clients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon HTTP surface a non-Obsidian CLI needs — per-chat SSE stream, vault REST ops, extended `/health` — plus a shared `@voidos/protocol` workspace package and bearer-token auth, without changing the plugin's path.

**Architecture:** Stay inside the existing Hono `app.fetch` + Bun.serve setup. New routes mount through `mountApi`. Auth is a Hono middleware that wraps only the new + modified routes (existing routes stay open for plugin compatibility). SSE uses Hono's `streamSSE`. Shared types live in a sibling `protocol/` package, wired through Bun workspaces. Tests boot the app via `buildApp({db, vaultRoot})` and exercise `app.fetch` directly (the pattern every existing route test uses).

**Tech Stack:** Bun 1.x · Hono ^4.12 · zod ^4.4 · bun:test · bun:sqlite

**Worktree:** `/Users/admin/hub-wt/VOS-116/`
**Repo subdir for code work:** `workspace/void-os/`
**Branch:** `task/VOS-116`

**Companion spec:** `workspace/void-os/docs/superpowers/specs/2026-05-17-VOS-116-daemon-http-api-design.md`

---

## File Structure

### `protocol/` (new package)

```
workspace/void-os/protocol/
  package.json          # name "@voidos/protocol"
  tsconfig.json
  src/
    index.ts            # re-exports all schemas + types
    auth.ts             # AuthError enum + zod schemas for error bodies
    health.ts           # HealthResp
    agents.ts           # AgentListEntry (lifted from daemon/src/agents/types.ts)
    chats.ts            # CreateChatReq, ChatRow
    chat-messages.ts    # SendMessageReq, MessageRow
    chat-stream.ts      # StreamFrame discriminated union
    vault.ts            # VaultReadResp, VaultWriteReq, VaultWriteResp, VaultListResp, VAULT_ERR
    events.ts           # WS frame types (deferred to plugin migration; ship minimal stub re-export)
  test/
    schemas.test.ts
```

### Daemon (touched files)

```
workspace/void-os/daemon/src/
  app.ts                  # MODIFY: wire new routes + auth middleware; capture bootTime
  index.ts                # MODIFY: load/issue token via auth/token.ts on boot
  api/
    index.ts              # MODIFY: extend /health, gate with auth
    vault.ts              # NEW: GET/PUT /vault/file, GET /vault/list
    chat-stream.ts        # NEW: GET /chat/:id/stream (SSE)
  auth/
    token.ts              # NEW: ensureToken() — read or generate ~/.void-os/token
    middleware.ts         # NEW: requireAuth Hono middleware
  events/
    index.ts              # MODIFY: add listenerCount()
  vault/
    paths.ts              # READ-ONLY: existing resolveVaultPath used as-is
    exclude.ts            # NEW: shared excluded-path matcher (.obsidian/.git/dotfiles)
  package.json            # MODIFY: add "@voidos/protocol": "workspace:*"
```

### Daemon tests (new + modified)

```
workspace/void-os/daemon/test/
  auth-middleware.test.ts   # NEW
  vault-routes.test.ts      # NEW
  chat-stream.test.ts       # NEW
  app-wiring.test.ts        # MODIFY: assert /health fields + auth gate
  events-listener-count.test.ts  # NEW: assert EventBus.listenerCount()
```

### Root + plugin + docs

```
workspace/void-os/
  package.json              # MODIFY: ensure "workspaces": ["daemon","plugin","protocol"]
  docs/api.md               # NEW: full HTTP surface reference
  plugin/package.json       # MODIFY: add "@voidos/protocol": "workspace:*" (transitive only)
```

---

## Implementation Order

1. **Task 1** — protocol/ scaffold + smoke test (gates Risk R1 fallback).
2. **Task 2** — `EventBus.listenerCount()` API (used by SSE leak test).
3. **Task 3** — Token issuance (`auth/token.ts`).
4. **Task 4** — Auth middleware (`auth/middleware.ts`).
5. **Task 5** — `/health` extension + auth gate.
6. **Task 6** — Vault `exclude.ts` helper.
7. **Task 7** — `GET /vault/file`.
8. **Task 8** — `PUT /vault/file` (hardened).
9. **Task 9** — `GET /vault/list`.
10. **Task 10** — SSE `GET /chat/:id/stream`.
11. **Task 11** — `docs/api.md`.
12. **Task 12** — Regression sweep + final integration smoke.

Every code task: write test → run failing → implement → run passing → commit. No skipping the failing-run step.

---

## Path conventions used in this plan

- All paths starting with `workspace/void-os/` are **relative to the worktree root** `/Users/admin/hub-wt/VOS-116/`.
- All bash commands run from `/Users/admin/hub-wt/VOS-116/workspace/void-os/` unless stated otherwise.
- Commits happen on branch `task/VOS-116` inside the worktree. **Never push.**

---

## Task 1: protocol/ package scaffold + smoke test

**Goal:** Stand up `protocol/` as a Bun workspace package and prove daemon can import from it. If this fails, fall back to tsconfig path-alias (see § 4 of spec).

**Files:**
- Create: `workspace/void-os/protocol/package.json`
- Create: `workspace/void-os/protocol/tsconfig.json`
- Create: `workspace/void-os/protocol/src/index.ts`
- Create: `workspace/void-os/protocol/src/health.ts`
- Create: `workspace/void-os/protocol/test/schemas.test.ts`
- Modify: `workspace/void-os/package.json` — ensure workspaces array
- Modify: `workspace/void-os/daemon/package.json` — add protocol dep
- Modify: `workspace/void-os/plugin/package.json` — add protocol dep (forward-compat)

- [ ] **Step 1.1: Inspect existing void-os root package.json**

```bash
cat workspace/void-os/package.json
```

Note whether `workspaces` already exists. If yes, append `"protocol"`; if no, add the array.

- [ ] **Step 1.2: Write protocol/package.json**

```json
{
  "name": "@voidos/protocol",
  "version": "0.0.1",
  "type": "module",
  "module": "src/index.ts",
  "main": "src/index.ts",
  "private": true,
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 1.3: Write protocol/tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "target": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 1.4: Write protocol/src/health.ts (first schema)**

```ts
import { z } from "zod";

export const HealthResp = z.object({
  ok: z.literal(true),
  version: z.string(),
  vault_root: z.string(),
  uptime_s: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type HealthResp = z.infer<typeof HealthResp>;
```

- [ ] **Step 1.5: Write protocol/src/index.ts**

```ts
export * from "./health.ts";
```

- [ ] **Step 1.6: Write the failing smoke test**

`workspace/void-os/protocol/test/schemas.test.ts`:

```ts
import { test, expect } from "bun:test";
import { HealthResp } from "../src/index.ts";

test("HealthResp parses a complete fixture", () => {
  const fixture = {
    ok: true,
    version: "0.0.1",
    vault_root: "/tmp/vault",
    uptime_s: 42,
    sessions: 0,
  };
  expect(() => HealthResp.parse(fixture)).not.toThrow();
});

test("HealthResp rejects negative uptime", () => {
  expect(() => HealthResp.parse({ ok: true, version: "x", vault_root: "/", uptime_s: -1, sessions: 0 })).toThrow();
});

test("HealthResp infers correct type", () => {
  // Compile-time: this is a type test. If HealthResp type drifts, tsc fails.
  const x: HealthResp = { ok: true, version: "v", vault_root: "/v", uptime_s: 0, sessions: 0 };
  expect(x.ok).toBe(true);
});
```

- [ ] **Step 1.7: Run the protocol package test**

```bash
cd workspace/void-os/protocol && bun install && bun test
```

Expected: 3 tests pass. If `bun install` complains about workspace resolution, see Step 1.13 fallback.

- [ ] **Step 1.8: Add protocol to root workspaces array**

Modify `workspace/void-os/package.json` so the `workspaces` field includes `"protocol"`. If file doesn't have a `workspaces` field yet, add:

```json
"workspaces": ["daemon", "plugin", "protocol"]
```

- [ ] **Step 1.9: Add @voidos/protocol to daemon deps**

In `workspace/void-os/daemon/package.json`, add to `dependencies`:

```json
"@voidos/protocol": "workspace:*"
```

- [ ] **Step 1.10: Add @voidos/protocol to plugin deps (forward-compat only)**

In `workspace/void-os/plugin/package.json`, add to `dependencies`:

```json
"@voidos/protocol": "workspace:*"
```

- [ ] **Step 1.11: Run root bun install to wire the workspace**

```bash
cd workspace/void-os && bun install
```

Expected: completes without "could not resolve workspace" errors.

- [ ] **Step 1.12: Daemon smoke import — write the test**

`workspace/void-os/daemon/test/protocol-smoke.test.ts`:

```ts
import { test, expect } from "bun:test";
import { HealthResp } from "@voidos/protocol";

test("daemon can import HealthResp from @voidos/protocol", () => {
  const sample = HealthResp.parse({
    ok: true,
    version: "0.0.1",
    vault_root: "/tmp",
    uptime_s: 1,
    sessions: 0,
  });
  expect(sample.ok).toBe(true);
});
```

- [ ] **Step 1.13: Run daemon smoke test**

```bash
cd workspace/void-os/daemon && bun test test/protocol-smoke.test.ts
```

Expected: PASS. If FAIL with module-resolution error:

**Fallback path (per spec Risk R1):**
1. Remove `@voidos/protocol` from `daemon/package.json` and `plugin/package.json`.
2. Add to `daemon/tsconfig.json` (or create if missing):
   ```json
   "compilerOptions": {
     "paths": { "@voidos/protocol": ["../protocol/src/index.ts"], "@voidos/protocol/*": ["../protocol/src/*"] },
     "baseUrl": "."
   }
   ```
3. Re-run smoke test. Document deviation in `## Decisions` of task file via a Work Log entry.

- [ ] **Step 1.14: Commit**

```bash
cd workspace/void-os && git add protocol/ daemon/test/protocol-smoke.test.ts daemon/package.json plugin/package.json package.json && git commit -m "feat(VOS-116): protocol/ workspace package scaffold + daemon smoke import"
```

---

## Task 2: EventBus.listenerCount()

**Goal:** Expose total listener count across all subscribed types so the SSE leak test in Task 10 can assert post-disconnect baseline.

**Files:**
- Modify: `workspace/void-os/daemon/src/events/index.ts`
- Create: `workspace/void-os/daemon/test/events-listener-count.test.ts`

- [ ] **Step 2.1: Write the failing test**

`workspace/void-os/daemon/test/events-listener-count.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createEventBus } from "../src/events/index.ts";

test("listenerCount returns 0 on empty bus", () => {
  const bus = createEventBus();
  expect(bus.listenerCount()).toBe(0);
});

test("listenerCount sums across types", () => {
  const bus = createEventBus();
  const u1 = bus.subscribe("text", () => {});
  const u2 = bus.subscribe("text", () => {});
  const u3 = bus.subscribe("run.end", () => {});
  expect(bus.listenerCount()).toBe(3);
  u2();
  expect(bus.listenerCount()).toBe(2);
  u1();
  u3();
  expect(bus.listenerCount()).toBe(0);
});
```

- [ ] **Step 2.2: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/events-listener-count.test.ts
```

Expected: FAIL — `bus.listenerCount is not a function`.

- [ ] **Step 2.3: Implement listenerCount**

Modify `workspace/void-os/daemon/src/events/index.ts`. Update the `EventBus` interface and the returned object:

Interface (around line 46-49):

```ts
export interface EventBus {
  emit(event: DaemonEvent): void;
  subscribe(type: string, handler: (event: DaemonEvent) => void): () => void;
  listenerCount(): number;
}
```

Inside `createEventBus`, append to the returned object (after `subscribe`):

```ts
    listenerCount() {
      let n = 0;
      for (const set of subs.values()) n += set.size;
      return n;
    },
```

- [ ] **Step 2.4: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/events-listener-count.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Run full daemon test suite to catch regressions**

```bash
cd workspace/void-os/daemon && bun test
```

Expected: all tests pass. The interface addition is non-breaking (existing callers ignore the new method).

- [ ] **Step 2.6: Commit**

```bash
cd workspace/void-os && git add daemon/src/events/index.ts daemon/test/events-listener-count.test.ts && git commit -m "feat(VOS-116): EventBus.listenerCount() for leak-detection tests"
```

---

## Task 3: Token issuance (`auth/token.ts`)

**Goal:** On daemon boot, ensure `~/.void-os/token` exists (mode 0600), generate if missing, return its contents.

**Files:**
- Create: `workspace/void-os/daemon/src/auth/token.ts`
- Create: `workspace/void-os/daemon/test/auth-token.test.ts`

- [ ] **Step 3.1: Write the failing test**

`workspace/void-os/daemon/test/auth-token.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureToken } from "../src/auth/token.ts";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vos-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("ensureToken generates a new token when file absent", () => {
  const token = ensureToken();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const tokenFile = path.join(tmpHome, ".void-os", "token");
  expect(fs.existsSync(tokenFile)).toBe(true);
  expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(token);
});

test("ensureToken reuses existing token", () => {
  fs.mkdirSync(path.join(tmpHome, ".void-os"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tmpHome, ".void-os", "token"), "deadbeef".repeat(8) + "\n", { mode: 0o600 });
  const token = ensureToken();
  expect(token).toBe("deadbeef".repeat(8));
});

test("ensureToken sets file mode 0600 on creation", () => {
  ensureToken();
  const stat = fs.statSync(path.join(tmpHome, ".void-os", "token"));
  // On macOS/Linux: only owner read+write.
  expect(stat.mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 3.2: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/auth-token.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement ensureToken**

`workspace/void-os/daemon/src/auth/token.ts`:

```ts
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function ensureToken(): string {
  const dir = path.join(os.homedir(), ".void-os");
  const file = path.join(dir, "token");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tok = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, tok + "\n", { mode: 0o600 });
    return tok;
  }
  return fs.readFileSync(file, "utf8").trim();
}
```

- [ ] **Step 3.4: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/auth-token.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 3.5: Commit**

```bash
cd workspace/void-os && git add daemon/src/auth/token.ts daemon/test/auth-token.test.ts && git commit -m "feat(VOS-116): ensureToken() — issue/load ~/.void-os/token"
```

---

## Task 4: Auth middleware (`auth/middleware.ts`)

**Goal:** Hono middleware that enforces bearer token (header or `?token=`) + Origin allowlist on routes it wraps.

**Files:**
- Create: `workspace/void-os/daemon/src/auth/middleware.ts`
- Create: `workspace/void-os/daemon/test/auth-middleware.test.ts`

- [ ] **Step 4.1: Write the failing test**

`workspace/void-os/daemon/test/auth-middleware.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { makeRequireAuth } from "../src/auth/middleware.ts";

function buildAuthApp(token: string) {
  const app = new Hono();
  app.use("/secured/*", makeRequireAuth(token));
  app.get("/secured/ping", (c) => c.json({ ok: true }));
  app.get("/open/ping", (c) => c.json({ ok: true }));
  return app;
}

test("Authorization Bearer matches token → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping", {
    headers: { Authorization: "Bearer good" },
  });
  expect(res.status).toBe(200);
});

test("?token= query matches token → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good");
  expect(res.status).toBe(200);
});

test("missing token → 401", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping");
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("E_UNAUTHORIZED");
});

test("wrong token → 401", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping", {
    headers: { Authorization: "Bearer wrong" },
  });
  expect(res.status).toBe(401);
});

test("Origin header from browser is rejected → 403", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good", {
    headers: { Origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("E_BAD_ORIGIN");
});

test("no Origin header (CLI) is allowed → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good");
  expect(res.status).toBe(200);
});

test("unsecured route remains open without token", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/open/ping");
  expect(res.status).toBe(200);
});
```

- [ ] **Step 4.2: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/auth-middleware.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement middleware**

`workspace/void-os/daemon/src/auth/middleware.ts`:

```ts
import type { MiddlewareHandler } from "hono";

// Browser origins are rejected by default. To allow specific browser callers
// (e.g. a future web UI), add their origin string to this set.
const ALLOWED_ORIGINS = new Set<string>();

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

export function makeRequireAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: "E_BAD_ORIGIN" }, 403);
    }
    const supplied =
      bearerFrom(c.req.header("Authorization")) ?? c.req.query("token");
    if (supplied !== expectedToken) {
      return c.json({ error: "E_UNAUTHORIZED" }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4.4: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/auth-middleware.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 4.5: Commit**

```bash
cd workspace/void-os && git add daemon/src/auth/middleware.ts daemon/test/auth-middleware.test.ts && git commit -m "feat(VOS-116): requireAuth middleware — bearer token + Origin check"
```

---

## Task 5: `/health` extension + wire auth + bootTime

**Goal:** `/health` returns `{ok, version, vault_root, uptime_s, sessions}` and now requires auth. `buildApp` accepts a token + bootTime; `daemon/src/index.ts` plumbs them through.

**Files:**
- Modify: `workspace/void-os/daemon/src/app.ts`
- Modify: `workspace/void-os/daemon/src/api/index.ts`
- Modify: `workspace/void-os/daemon/src/index.ts`
- Modify: `workspace/void-os/daemon/test/app-wiring.test.ts`

- [ ] **Step 5.1: Read current shape of buildApp + mountApi**

```bash
sed -n '1,120p' workspace/void-os/daemon/src/app.ts
sed -n '1,60p' workspace/void-os/daemon/src/api/index.ts
```

Note the existing `BuildDeps` / `ApiContext` shapes.

- [ ] **Step 5.2: Write the failing test (extended app-wiring)**

Locate the existing `/health` test in `workspace/void-os/daemon/test/app-wiring.test.ts` (line ~30, `await app.fetch(new Request("http://x/health"))`). Add three new tests appended to that file:

```ts
test("GET /health requires auth — missing token → 401", async () => {
  const { app } = await bootstrap({ token: "secret" });
  const res = await app.request("/health");
  expect(res.status).toBe(401);
});

test("GET /health with valid token returns extended shape", async () => {
  const { app, vaultRoot } = await bootstrap({ token: "secret" });
  const res = await app.request("/health", { headers: { Authorization: "Bearer secret" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
  expect(body.vault_root).toBe(vaultRoot);
  expect(typeof body.uptime_s).toBe("number");
  expect(Number.isInteger(body.uptime_s)).toBe(true);
});

test("GET /health rejects browser Origin", async () => {
  const { app } = await bootstrap({ token: "secret" });
  const res = await app.request("/health?token=secret", { headers: { Origin: "https://x" } });
  expect(res.status).toBe(403);
});
```

You will also need to update the existing `bootstrap` helper to accept `token`. Find the helper (`async function bootstrap(...)` near the top of the file) and add the parameter:

```ts
async function bootstrap(opts: { token?: string } = {}) {
  // ...existing body...
  const app = await buildApp({
    db,
    vaultRoot,
    // existing args,
    token: opts.token ?? "test-token",
    bootTime: Date.now(),
  });
  return { app, db, vaultRoot };
}
```

If existing tests in this file call `bootstrap()` without args, the default `"test-token"` keeps them working — but they will start failing because `/health` now requires auth. **Update each existing `/health` call site in this file to pass `Authorization: Bearer test-token`**, then re-run.

- [ ] **Step 5.3: Run test — verify expected failures**

```bash
cd workspace/void-os/daemon && bun test test/app-wiring.test.ts
```

Expected: FAIL on the three new tests (and any existing `/health` tests that didn't get the token) — buildApp doesn't accept `token`/`bootTime` yet; `/health` doesn't have `vault_root`/`uptime_s`/auth gate.

- [ ] **Step 5.4: Extend `buildApp` signature**

In `workspace/void-os/daemon/src/app.ts`, locate the `BuildDeps`-style interface and add:

```ts
interface BuildDeps {
  // ... existing fields ...
  token: string;
  bootTime: number;
}
```

Pass them through to `mountApi`:

```ts
mountApi(app, { version: VERSION, db: deps.db, tz: resolveTz(process.env), vaultRoot: deps.vaultRoot, token: deps.token, bootTime: deps.bootTime });
```

(Adjust the existing `ApiContext` interface in `api/index.ts` accordingly — see next step.)

- [ ] **Step 5.5: Extend `mountApi` + `/health`**

In `workspace/void-os/daemon/src/api/index.ts`:

```ts
import { makeRequireAuth } from "../auth/middleware.ts";

export interface ApiContext {
  version: string;
  db: Database;
  tz: string;
  vaultRoot: string;
  token: string;
  bootTime: number;
}

export const mountApi = (app: Hono, ctx: ApiContext): void => {
  const requireAuth = makeRequireAuth(ctx.token);
  app.use("/health", requireAuth);
  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: ctx.version,
      vault_root: ctx.vaultRoot,
      uptime_s: Math.floor((Date.now() - ctx.bootTime) / 1000),
      sessions: 0,
    }),
  );
  mountCost(app, ctx);
};
```

- [ ] **Step 5.6: Plumb token + bootTime through `daemon/src/index.ts`**

At the top of `workspace/void-os/daemon/src/index.ts`, add:

```ts
import { ensureToken } from "./auth/token.ts";

const TOKEN = ensureToken();
const BOOT_TIME = Date.now();
```

Wherever `buildApp({...})` is called, add `token: TOKEN, bootTime: BOOT_TIME` to the object.

- [ ] **Step 5.7: Update other bootstrap callers in tests**

Other tests likely call `buildApp({ db, vaultRoot })` without `token`/`bootTime`. Strategy: make those two optional in `BuildDeps` with defaults — `token = "test-token"`, `bootTime = Date.now()`.

```ts
interface BuildDeps {
  // ...
  token?: string;
  bootTime?: number;
}
```

Inside buildApp:

```ts
const token = deps.token ?? "test-token";
const bootTime = deps.bootTime ?? Date.now();
```

This lets every existing test keep working without modification, while `daemon/src/index.ts` always passes the real values in prod.

- [ ] **Step 5.8: Run app-wiring tests**

```bash
cd workspace/void-os/daemon && bun test test/app-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 5.9: Run full daemon test suite**

```bash
cd workspace/void-os/daemon && bun test
```

Expected: all green. If existing tests break because they hit `/health` without a token, update them to pass `Authorization: Bearer test-token`. (Search: `grep -rn "/health" workspace/void-os/daemon/test`.)

- [ ] **Step 5.10: Commit**

```bash
cd workspace/void-os && git add daemon/src/app.ts daemon/src/api/index.ts daemon/src/index.ts daemon/test/app-wiring.test.ts && git commit -m "feat(VOS-116): extend /health with vault_root + uptime_s; gate via auth middleware"
```

If you had to edit other test files, include them in the same commit.

---

## Task 6: Vault `exclude.ts` helper

**Goal:** Single source of truth for "is this path excluded" (`.obsidian/`, `.git/`, dotfiles). Used by all three vault routes.

**Files:**
- Create: `workspace/void-os/daemon/src/vault/exclude.ts`
- Create: `workspace/void-os/daemon/test/vault-exclude.test.ts`

- [ ] **Step 6.1: Write the failing test**

`workspace/void-os/daemon/test/vault-exclude.test.ts`:

```ts
import { test, expect } from "bun:test";
import { isExcluded } from "../src/vault/exclude.ts";

test("plain file not excluded", () => {
  expect(isExcluded("notes/foo.md")).toBe(false);
});

test(".obsidian/* excluded", () => {
  expect(isExcluded(".obsidian/workspace.json")).toBe(true);
});

test(".git/* excluded", () => {
  expect(isExcluded(".git/HEAD")).toBe(true);
});

test("nested dotfile excluded", () => {
  expect(isExcluded("notes/.private.md")).toBe(true);
});

test("hidden dir at deep level excluded", () => {
  expect(isExcluded("notes/sub/.cache/foo")).toBe(true);
});

test("file named with leading dot excluded", () => {
  expect(isExcluded(".env")).toBe(true);
});

test("path with dots not at segment start is fine", () => {
  expect(isExcluded("notes/foo.bar.md")).toBe(false);
});
```

- [ ] **Step 6.2: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/vault-exclude.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement**

`workspace/void-os/daemon/src/vault/exclude.ts`:

```ts
// Returns true if any path segment starts with "." — covers .obsidian, .git,
// .env, .DS_Store, and arbitrarily nested hidden dirs/files.
export function isExcluded(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  for (const seg of norm.split("/")) {
    if (seg.startsWith(".") && seg !== "" && seg !== "." && seg !== "..") {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 6.4: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/vault-exclude.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 6.5: Commit**

```bash
cd workspace/void-os && git add daemon/src/vault/exclude.ts daemon/test/vault-exclude.test.ts && git commit -m "feat(VOS-116): isExcluded() — shared dotfile/.obsidian/.git matcher"
```

---

## Task 7: `GET /vault/file`

**Goal:** Read a UTF-8 file under vaultRoot with scope guard + exclusion + binary detection. 200 / 404 / 403 / 415.

**Files:**
- Create: `workspace/void-os/daemon/src/api/vault.ts`
- Create: `workspace/void-os/protocol/src/vault.ts`
- Modify: `workspace/void-os/protocol/src/index.ts` (re-export)
- Create: `workspace/void-os/daemon/test/vault-routes.test.ts`
- Modify: `workspace/void-os/daemon/src/app.ts` to mount vault routes

- [ ] **Step 7.1: Add vault schemas to protocol package**

`workspace/void-os/protocol/src/vault.ts`:

```ts
import { z } from "zod";

export const VAULT_ERR = z.enum([
  "E_NOT_FOUND",
  "E_OUT_OF_SCOPE",
  "E_TRAVERSAL",
  "E_BINARY",
  "E_EXCLUDED",
  "E_SYMLINK_ESCAPE",
  "E_TOO_LARGE",
  "E_INVALID_BODY",
]);
export type VaultErr = z.infer<typeof VAULT_ERR>;

export const VaultReadResp = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultReadResp = z.infer<typeof VaultReadResp>;

export const VaultWriteReq = z.object({
  path: z.string().min(1),
  content: z.string().max(10 * 1024 * 1024),
});
export type VaultWriteReq = z.infer<typeof VaultWriteReq>;

export const VaultWriteResp = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultWriteResp = z.infer<typeof VaultWriteResp>;

export const VaultListEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultListEntry = z.infer<typeof VaultListEntry>;

export const VaultListResp = z.object({
  path: z.string(),
  entries: z.array(VaultListEntry),
});
export type VaultListResp = z.infer<typeof VaultListResp>;
```

Modify `workspace/void-os/protocol/src/index.ts`:

```ts
export * from "./health.ts";
export * from "./vault.ts";
```

- [ ] **Step 7.2: Write the failing test**

`workspace/void-os/daemon/test/vault-routes.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/app.ts";

interface Ctx { app: Awaited<ReturnType<typeof buildApp>>; vaultRoot: string }
let ctx: Ctx;
const TOKEN = "test-token";
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  const vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")));
  const db = new Database(":memory:");
  // Bare schema — vault routes don't touch DB but buildApp expects it.
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');`);
  const app = await buildApp({ db, vaultRoot, token: TOKEN, bootTime: Date.now() });
  ctx = { app, vaultRoot };
});

afterEach(() => {
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

test("GET /vault/file — read existing file", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "hi.md"), "# hello\n");
  const res = await ctx.app.request("/vault/file?path=hi.md", { headers: auth });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { path: string; content: string; size: number; mtime: number };
  expect(body.content).toBe("# hello\n");
  expect(body.size).toBe(8);
  expect(body.path).toBe(path.join(ctx.vaultRoot, "hi.md"));
});

test("GET /vault/file — missing path → 404 E_NOT_FOUND", async () => {
  const res = await ctx.app.request("/vault/file?path=nope.md", { headers: auth });
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("E_NOT_FOUND");
});

test("GET /vault/file — traversal → 403 E_OUT_OF_SCOPE", async () => {
  const res = await ctx.app.request("/vault/file?path=../../etc/passwd", { headers: auth });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_OUT_OF_SCOPE");
});

test("GET /vault/file — excluded path → 403 E_EXCLUDED", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, ".obsidian"));
  fs.writeFileSync(path.join(ctx.vaultRoot, ".obsidian", "workspace.json"), "{}");
  const res = await ctx.app.request("/vault/file?path=.obsidian/workspace.json", { headers: auth });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_EXCLUDED");
});

test("GET /vault/file — non-UTF8 → 415 E_BINARY", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const res = await ctx.app.request("/vault/file?path=bin", { headers: auth });
  expect(res.status).toBe(415);
  expect((await res.json() as any).error).toBe("E_BINARY");
});

test("GET /vault/file — no token → 401", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "a"), "x");
  const res = await ctx.app.request("/vault/file?path=a");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 7.3: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: FAIL — route not mounted.

- [ ] **Step 7.4: Implement `GET /vault/file`**

`workspace/void-os/daemon/src/api/vault.ts`:

```ts
import type { Hono } from "hono";
import * as fs from "node:fs";
import { resolveVaultPath, ERR } from "../vault/paths.ts";
import { isExcluded } from "../vault/exclude.ts";

interface Deps { vaultRoot: string }

function mapResolveError(e: unknown): { status: 400 | 403; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === ERR.PATH_MUST_BE_RELATIVE) return { status: 400, error: "E_TRAVERSAL" };
  if (msg === ERR.PATH_ESCAPES_VAULT_ROOT) return { status: 403, error: "E_OUT_OF_SCOPE" };
  return { status: 400, error: "E_TRAVERSAL" };
}

export function mountVault(app: Hono, deps: Deps): void {
  const vaultRoot = fs.realpathSync(deps.vaultRoot);

  app.get("/vault/file", (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "E_INVALID_BODY" }, 400);
    if (isExcluded(rel)) return c.json({ error: "E_EXCLUDED" }, 403);

    let abs: string;
    try { abs = resolveVaultPath(rel, vaultRoot); }
    catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }

    if (!fs.existsSync(abs)) return c.json({ error: "E_NOT_FOUND" }, 404);

    const buf = fs.readFileSync(abs);
    if (!Buffer.isUtf8(buf)) return c.json({ error: "E_BINARY" }, 415);

    const stat = fs.statSync(abs);
    return c.json({
      path: abs,
      content: buf.toString("utf8"),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  });
}
```

- [ ] **Step 7.5: Wire vault routes into app**

In `workspace/void-os/daemon/src/app.ts`, after `mountApi(app, ...)`, add:

```ts
import { mountVault } from "./api/vault.ts";
import { makeRequireAuth } from "./auth/middleware.ts";
```

After the call to `mountApi`:

```ts
app.use("/vault/*", makeRequireAuth(token));
mountVault(app, { vaultRoot: deps.vaultRoot });
```

(Use the `token` local already created in Task 5; if buildApp doesn't have it in scope, hoist.)

- [ ] **Step 7.6: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 7.7: Commit**

```bash
cd workspace/void-os && git add daemon/src/api/vault.ts daemon/src/app.ts daemon/test/vault-routes.test.ts protocol/src/vault.ts protocol/src/index.ts && git commit -m "feat(VOS-116): GET /vault/file — UTF-8 read with scope/exclude/binary guards"
```

---

## Task 8: `PUT /vault/file`

**Goal:** Write with all the hardening from Forge #4 — 10 MB cap, atomic tmp+rename, realpath checks on parent + target, exclusion list.

**Files:**
- Modify: `workspace/void-os/daemon/src/api/vault.ts`
- Modify: `workspace/void-os/daemon/test/vault-routes.test.ts`

- [ ] **Step 8.1: Append failing tests**

Append to `workspace/void-os/daemon/test/vault-routes.test.ts`:

```ts
test("PUT /vault/file — write new file round-trips", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "new.md", content: "hello\n" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.path).toBe(path.join(ctx.vaultRoot, "new.md"));
  expect(body.size).toBe(6);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "new.md"), "utf8")).toBe("hello\n");
});

test("PUT /vault/file — overwrites existing", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "x"), "old");
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "x", content: "new" }),
  });
  expect(res.status).toBe(200);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "x"), "utf8")).toBe("new");
});

test("PUT /vault/file — creates parent dirs", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "a/b/c.md", content: "deep" }),
  });
  expect(res.status).toBe(200);
  expect(fs.readFileSync(path.join(ctx.vaultRoot, "a/b/c.md"), "utf8")).toBe("deep");
});

test("PUT /vault/file — body > 10MB → 413 E_TOO_LARGE", async () => {
  const big = "a".repeat(10 * 1024 * 1024 + 1);
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "big.txt", content: big }),
  });
  expect(res.status).toBe(413);
  expect((await res.json() as any).error).toBe("E_TOO_LARGE");
});

test("PUT /vault/file — excluded dest → 403 E_EXCLUDED", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: ".obsidian/x.json", content: "{}" }),
  });
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toBe("E_EXCLUDED");
});

test("PUT /vault/file — symlink escape rejected", async () => {
  // Create a symlink inside vault that points outside vault.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.symlinkSync(outside, path.join(ctx.vaultRoot, "link"));
  try {
    const res = await ctx.app.request("/vault/file", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ path: "link/x.md", content: "escape!" }),
    });
    expect(res.status).toBe(403);
    const err = (await res.json() as any).error;
    // Either E_SYMLINK_ESCAPE or E_OUT_OF_SCOPE acceptable; both block.
    expect(["E_SYMLINK_ESCAPE", "E_OUT_OF_SCOPE"]).toContain(err);
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("PUT /vault/file — malformed body → 400 E_INVALID_BODY", async () => {
  const res = await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "", content: "x" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("E_INVALID_BODY");
});

test("PUT /vault/file — write is atomic (no .tmp leaks on success)", async () => {
  await ctx.app.request("/vault/file", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ path: "atomic.md", content: "done" }),
  });
  const siblings = fs.readdirSync(ctx.vaultRoot);
  expect(siblings.some(n => n.startsWith("atomic.md.tmp-"))).toBe(false);
});
```

- [ ] **Step 8.2: Run tests — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: 8 new tests fail (route not implemented).

- [ ] **Step 8.3: Implement PUT in api/vault.ts**

Add to `workspace/void-os/daemon/src/api/vault.ts`:

```ts
import * as path from "node:path";
import * as crypto from "node:crypto";
import { VaultWriteReq } from "@voidos/protocol";

// ... existing imports + mountVault wrapper ...

  app.put("/vault/file", async (c) => {
    // Hard cap before reading body to avoid OOM on hostile content.
    const lenHeader = c.req.header("content-length");
    if (lenHeader && Number(lenHeader) > 10 * 1024 * 1024 + 1024) {
      return c.json({ error: "E_TOO_LARGE" }, 413);
    }

    let parsed;
    try { parsed = VaultWriteReq.parse(await c.req.json()); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Too big") || msg.includes("max")) return c.json({ error: "E_TOO_LARGE" }, 413);
      return c.json({ error: "E_INVALID_BODY" }, 400);
    }

    if (isExcluded(parsed.path)) return c.json({ error: "E_EXCLUDED" }, 403);

    let abs: string;
    try { abs = resolveVaultPath(parsed.path, vaultRoot); }
    catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }

    // Realpath-check the parent of the target — if the parent is a symlink
    // out of vault, reject.
    const parent = path.dirname(abs);
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      if (realParent !== vaultRoot && !realParent.startsWith(vaultRoot + path.sep)) {
        return c.json({ error: "E_SYMLINK_ESCAPE" }, 403);
      }
    }

    fs.mkdirSync(parent, { recursive: true });

    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, parsed.content, { encoding: "utf8" });
    try {
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }

    const stat = fs.statSync(abs);
    return c.json({
      path: abs,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  });
```

- [ ] **Step 8.4: Run tests — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: PASS (14 tests now in this file).

- [ ] **Step 8.5: Commit**

```bash
cd workspace/void-os && git add daemon/src/api/vault.ts daemon/test/vault-routes.test.ts && git commit -m "feat(VOS-116): PUT /vault/file — atomic write + size cap + symlink guard"
```

---

## Task 9: `GET /vault/list`

**Goal:** Recursive listing under vaultRoot with depth limit, exclusions, sorted entries.

**Files:**
- Modify: `workspace/void-os/daemon/src/api/vault.ts`
- Modify: `workspace/void-os/daemon/test/vault-routes.test.ts`

- [ ] **Step 9.1: Append failing tests**

Append to `workspace/void-os/daemon/test/vault-routes.test.ts`:

```ts
test("GET /vault/list — shallow root", async () => {
  fs.writeFileSync(path.join(ctx.vaultRoot, "a.md"), "a");
  fs.writeFileSync(path.join(ctx.vaultRoot, "b.md"), "b");
  fs.mkdirSync(path.join(ctx.vaultRoot, "sub"));
  fs.writeFileSync(path.join(ctx.vaultRoot, "sub", "c.md"), "c");
  const res = await ctx.app.request("/vault/list?depth=1", { headers: auth });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.path).toBe(ctx.vaultRoot);
  const names = (body.entries as any[]).map(e => e.name).sort();
  expect(names).toEqual(["a.md", "b.md", "sub"]);
  const sub = (body.entries as any[]).find(e => e.name === "sub");
  expect(sub.type).toBe("dir");
});

test("GET /vault/list — deep includes nested entries", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, "x"));
  fs.writeFileSync(path.join(ctx.vaultRoot, "x", "y.md"), "y");
  const res = await ctx.app.request("/vault/list?path=x", { headers: auth });
  const body = (await res.json()) as any;
  expect(body.entries.map((e: any) => e.name)).toEqual(["y.md"]);
});

test("GET /vault/list — excludes .obsidian + dotfiles", async () => {
  fs.mkdirSync(path.join(ctx.vaultRoot, ".obsidian"));
  fs.writeFileSync(path.join(ctx.vaultRoot, ".obsidian", "x"), "");
  fs.writeFileSync(path.join(ctx.vaultRoot, ".env"), "");
  fs.writeFileSync(path.join(ctx.vaultRoot, "visible.md"), "");
  const res = await ctx.app.request("/vault/list?depth=1", { headers: auth });
  const body = (await res.json()) as any;
  const names = (body.entries as any[]).map(e => e.name);
  expect(names).toEqual(["visible.md"]);
});

test("GET /vault/list — missing path → 404", async () => {
  const res = await ctx.app.request("/vault/list?path=nope", { headers: auth });
  expect(res.status).toBe(404);
});

test("GET /vault/list — traversal → 403", async () => {
  const res = await ctx.app.request("/vault/list?path=../..", { headers: auth });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 9.2: Run tests — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: 5 new failures.

- [ ] **Step 9.3: Implement GET /vault/list**

Add to `workspace/void-os/daemon/src/api/vault.ts`, inside `mountVault`:

```ts
  app.get("/vault/list", (c) => {
    const rel = c.req.query("path") ?? "";
    const depthRaw = c.req.query("depth");
    const depth = depthRaw ? Math.max(1, parseInt(depthRaw, 10) || 1) : Number.POSITIVE_INFINITY;

    let abs: string;
    if (rel === "" || rel === ".") {
      abs = vaultRoot;
    } else {
      if (isExcluded(rel)) return c.json({ error: "E_EXCLUDED" }, 403);
      try { abs = resolveVaultPath(rel, vaultRoot); }
      catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }
    }

    if (!fs.existsSync(abs)) return c.json({ error: "E_NOT_FOUND" }, 404);

    const entries: Array<{name: string; type: "file"|"dir"; size: number; mtime: number}> = [];
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      return c.json({ error: "E_NOT_FOUND" }, 404);
    }

    function walk(dir: string, remaining: number) {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith(".")) continue;  // excludes .obsidian, .git, dotfiles
        const child = `${dir}/${name}`;
        const s = fs.statSync(child);
        const type: "file"|"dir" = s.isDirectory() ? "dir" : "file";
        // Only emit at top level of the requested path for v1 ergonomics.
        // Deeper recursion enumerates children in-place is overkill — flatten if needed.
        if (dir === abs) {
          entries.push({ name, type, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
        }
        if (type === "dir" && remaining > 1) walk(child, remaining - 1);
      }
    }
    walk(abs, depth);

    return c.json({ path: abs, entries });
  });
```

Note: for v1 the response only includes entries directly inside the requested directory (not deeper recursive items). `depth > 1` is reserved for future flattening; tests above only exercise depth=1 / default (which behaves the same as depth=1 for top-level).

- [ ] **Step 9.4: Run tests — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/vault-routes.test.ts
```

Expected: PASS (all 19 vault tests).

- [ ] **Step 9.5: Commit**

```bash
cd workspace/void-os && git add daemon/src/api/vault.ts daemon/test/vault-routes.test.ts && git commit -m "feat(VOS-116): GET /vault/list — shallow listing with exclusions"
```

---

## Task 10: `GET /chat/:id/stream` — per-chat SSE

**Goal:** SSE stream scoped to one chat. First frame `hello`. Closes on any `run_end` matching the chat. Asserts no listener leak on disconnect.

**Files:**
- Modify: `workspace/void-os/protocol/src/chat-stream.ts` (new file)
- Modify: `workspace/void-os/protocol/src/index.ts`
- Create: `workspace/void-os/daemon/src/api/chat-stream.ts`
- Create: `workspace/void-os/daemon/test/chat-stream.test.ts`
- Modify: `workspace/void-os/daemon/src/app.ts`

- [ ] **Step 10.1: Add chat-stream schemas to protocol**

`workspace/void-os/protocol/src/chat-stream.ts`:

```ts
import { z } from "zod";

const HelloData = z.object({ chat_id: z.string(), version: z.string() });
const TextData = z.object({ run_id: z.string(), delta: z.string() });
const ToolUseData = z.object({ run_id: z.string(), name: z.string(), input: z.unknown() });
const ToolResultData = z.object({ run_id: z.string(), name: z.string(), ok: z.boolean() });
const AskUserData = z.object({ run_id: z.string(), task_id: z.string(), prompt: z.string(), options: z.array(z.string()).optional() });
const UsageData = z.object({ run_id: z.string(), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() });
const RunEndData = z.object({ run_id: z.string(), status: z.string() });
const ErrorData = z.object({ message: z.string() });

export const StreamFrame = z.discriminatedUnion("event", [
  z.object({ event: z.literal("hello"), data: HelloData }),
  z.object({ event: z.literal("text"), data: TextData }),
  z.object({ event: z.literal("tool_use"), data: ToolUseData }),
  z.object({ event: z.literal("tool_result"), data: ToolResultData }),
  z.object({ event: z.literal("ask_user"), data: AskUserData }),
  z.object({ event: z.literal("usage"), data: UsageData }),
  z.object({ event: z.literal("run_end"), data: RunEndData }),
  z.object({ event: z.literal("error"), data: ErrorData }),
]);
export type StreamFrame = z.infer<typeof StreamFrame>;
```

Update `workspace/void-os/protocol/src/index.ts`:

```ts
export * from "./health.ts";
export * from "./vault.ts";
export * from "./chat-stream.ts";
```

Add a quick round-trip test to `protocol/test/schemas.test.ts`:

```ts
import { StreamFrame } from "../src/index.ts";

test("StreamFrame accepts hello", () => {
  expect(() => StreamFrame.parse({ event: "hello", data: { chat_id: "c1", version: "0.0.1" } })).not.toThrow();
});

test("StreamFrame rejects unknown event", () => {
  expect(() => StreamFrame.parse({ event: "weird", data: {} })).toThrow();
});
```

Run `cd workspace/void-os/protocol && bun test`. Expected: PASS.

- [ ] **Step 10.2: Write the failing daemon test**

`workspace/void-os/daemon/test/chat-stream.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createEventBus } from "../src/events/index.ts";

const TOKEN = "test-token";
const MIGRATIONS_DIR = join(__dirname, "..", "src", "adapters", "sqlite", "migrations");

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  vaultRoot: string;
  db: Database;
  bus: ReturnType<typeof createEventBus>;
}
let ctx: Ctx;

beforeEach(async () => {
  const db = new Database(":memory:");
  for (const m of ["0001_init.sql","0002_runs_columns.sql","0003_chat_lifecycle.sql","0004_messages.sql","0005_costs_cache.sql","0006_costs_chat_id.sql","0007_a2a_tables.sql"]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cs-"));
  const bus = createEventBus();
  const app = await buildApp({ db, vaultRoot, token: TOKEN, bootTime: Date.now(), eventBus: bus });
  // Seed a chat row so route can find it.
  db.run("INSERT INTO chats (id, agent_name, title, created_at, updated_at) VALUES ('c1','maya',null,1,1)");
  ctx = { app, vaultRoot, db, bus };
});

afterEach(() => {
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

async function readSSE(res: Response, frameCount: number, timeoutMs = 2000): Promise<string[]> {
  const frames: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < frameCount && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 100)),
    ]);
    if (done) break;
    buf += decoder.decode(value!, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      frames.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  return frames;
}

test("missing token → 401", async () => {
  const res = await ctx.app.request("/chat/c1/stream");
  expect(res.status).toBe(401);
});

test("unknown chat → 404", async () => {
  const res = await ctx.app.request("/chat/nope/stream?token=" + TOKEN);
  expect(res.status).toBe(404);
});

test("hello frame first, closes on run_end", async () => {
  const before = ctx.bus.listenerCount();

  const resPromise = ctx.app.request("/chat/c1/stream?token=" + TOKEN);
  // Give the route a beat to subscribe.
  await new Promise(r => setTimeout(r, 20));
  const res = await resPromise;
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  // Wait a tick for subscribe to settle.
  await new Promise(r => setTimeout(r, 20));
  expect(ctx.bus.listenerCount()).toBe(before + 1);

  // Emit a text and a run_end for c1.
  ctx.bus.emit({ type: "text", chatId: "c1", runId: "r1", payload: { delta: "hi" } });
  ctx.bus.emit({ type: "run.end", chatId: "c1", runId: "r1", payload: { status: "ok" } });

  const frames = await readSSE(res, 3);
  // Frame 0 = hello, frame 1 = text, frame 2 = run_end.
  expect(frames[0]).toContain("event: hello");
  expect(frames[1]).toContain("event: text");
  expect(frames[2]).toContain("event: run_end");

  // After run_end, server closed → listener gone.
  await new Promise(r => setTimeout(r, 50));
  expect(ctx.bus.listenerCount()).toBe(before);
});

test("events for OTHER chats are not delivered", async () => {
  ctx.db.run("INSERT INTO chats (id, agent_name, title, created_at, updated_at) VALUES ('c2','maya',null,1,1)");
  const resPromise = ctx.app.request("/chat/c1/stream?token=" + TOKEN);
  await new Promise(r => setTimeout(r, 20));
  const res = await resPromise;
  ctx.bus.emit({ type: "text", chatId: "c2", runId: "r2", payload: { delta: "noise" } });
  ctx.bus.emit({ type: "text", chatId: "c1", runId: "r1", payload: { delta: "real" } });
  ctx.bus.emit({ type: "run.end", chatId: "c1", runId: "r1", payload: { status: "ok" } });

  const frames = await readSSE(res, 3);
  expect(frames.find(f => f.includes("noise"))).toBeUndefined();
  expect(frames.find(f => f.includes("real"))).toBeDefined();
});

test("client disconnect unsubscribes (no listener leak)", async () => {
  const before = ctx.bus.listenerCount();
  const ac = new AbortController();
  const resP = ctx.app.request("/chat/c1/stream?token=" + TOKEN, { signal: ac.signal });
  await new Promise(r => setTimeout(r, 20));
  await resP;
  await new Promise(r => setTimeout(r, 20));
  expect(ctx.bus.listenerCount()).toBe(before + 1);
  ac.abort();
  // Hono's onAbort needs a tick to fire.
  await new Promise(r => setTimeout(r, 50));
  expect(ctx.bus.listenerCount()).toBe(before);
});
```

Note: this test plumbs `eventBus` into `buildApp`. The existing `buildApp` may construct its own EventBus internally. If so, **modify `buildApp` to accept an optional `eventBus` param** and use it if provided (defaulting to a new one). This is a small refactor done as part of this task.

- [ ] **Step 10.3: Run test — verify failure**

```bash
cd workspace/void-os/daemon && bun test test/chat-stream.test.ts
```

Expected: FAIL (route absent).

- [ ] **Step 10.4: Implement `GET /chat/:id/stream`**

`workspace/void-os/daemon/src/api/chat-stream.ts`:

```ts
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Database } from "bun:sqlite";
import type { EventBus, DaemonEvent } from "../events/index.ts";

interface Deps {
  db: Database;
  bus: EventBus;
  version: string;
}

export function mountChatStream(app: Hono, deps: Deps): void {
  app.get("/chat/:id/stream", (c) => {
    const id = c.req.param("id");
    const row = deps.db.query("SELECT id FROM chats WHERE id = ?").get(id);
    if (!row) return c.json({ error: "E_NOT_FOUND" }, 404);

    const textOnly = c.req.query("text_only") === "1";

    return streamSSE(c, async (stream) => {
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try { await stream.close(); } catch { /* already closed */ }
      };

      const handler = (event: DaemonEvent) => {
        if (event.chatId !== id) return;
        let frame: { event: string; data: unknown } | null = null;
        switch (event.type) {
          case "text":
            frame = { event: "text", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "tool_use":
            if (textOnly) return;
            frame = { event: "tool_use", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "tool_result":
            if (textOnly) return;
            frame = { event: "tool_result", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "ask_user":
            frame = { event: "ask_user", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "usage":
            frame = { event: "usage", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "run.end":
            frame = { event: "run_end", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
        }
        if (!frame) return;
        stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) }).catch(() => {});
        if (frame.event === "run_end") void close();
      };

      const unsubscribe = deps.bus.subscribe("*", handler);

      stream.onAbort(() => void close());

      // First frame.
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ chat_id: id, version: deps.version }),
      });

      // Keep open until close() is called.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => { if (closed) { clearInterval(interval); resolve(); } }, 50);
      });
    });
  });
}
```

- [ ] **Step 10.5: Accept optional eventBus in buildApp**

In `workspace/void-os/daemon/src/app.ts`, locate where `createEventBus(...)` is called inside `buildApp`. Allow an injected one:

```ts
interface BuildDeps {
  // ...
  eventBus?: EventBus;
}
// ...
const eventBus = deps.eventBus ?? createEventBus({ db: deps.db });
```

Then wire chat-stream:

```ts
import { mountChatStream } from "./api/chat-stream.ts";

// after mountVault:
app.use("/chat/:id/stream", makeRequireAuth(token));
mountChatStream(app, { db: deps.db, bus: eventBus, version: VERSION });
```

- [ ] **Step 10.6: Run test — verify pass**

```bash
cd workspace/void-os/daemon && bun test test/chat-stream.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 10.7: Run full daemon suite + protocol suite**

```bash
cd workspace/void-os/daemon && bun test
cd workspace/void-os/protocol && bun test
```

Expected: all green. If `ws-events.test.ts` or other event-bus consumers break because the bus is now externally injected, verify they construct their own bus and don't share state — they should still work because `buildApp` defaults to a fresh bus when `eventBus` is absent.

- [ ] **Step 10.8: Commit**

```bash
cd workspace/void-os && git add daemon/src/api/chat-stream.ts daemon/src/app.ts daemon/test/chat-stream.test.ts protocol/src/chat-stream.ts protocol/src/index.ts protocol/test/schemas.test.ts && git commit -m "feat(VOS-116): GET /chat/:id/stream — per-chat SSE, hello-first, closes on run_end"
```

---

## Task 11: `docs/api.md`

**Goal:** Single source-of-truth endpoint reference, with auth section + every route documented.

**Files:**
- Create: `workspace/void-os/docs/api.md`

- [ ] **Step 11.1: Write docs/api.md**

`workspace/void-os/docs/api.md`:

```markdown
# void-os daemon HTTP API

Bun + Hono server bound to `127.0.0.1:7777`. Shared TS types live in
`@voidos/protocol` (workspace package).

## Authentication

A bearer token is generated on first boot at `~/.void-os/token` (file mode
0600, parent dir 0700). To rotate: delete the file and restart the daemon.

Pass it one of two ways:

- HTTP header: `Authorization: Bearer <token>`
- Query string: `?token=<token>` (used for SSE — `EventSource` cannot set
  headers)

Routes gated by auth (this task):

- `GET /health`
- `GET /chat/:id/stream`
- `GET /vault/file`, `PUT /vault/file`, `GET /vault/list`

**Known asymmetry:** existing routes (`/chats`, `/chat/*`, `/agents`,
`/events` WS, `/mcp`, `/cost/today`) are currently un-gated for plugin
backward compatibility. A follow-up milestone task will close this gap.

### Origin check

Requests with a `Origin:` header are rejected (403 `E_BAD_ORIGIN`) unless
the origin is in the daemon's allowlist (initially empty). CLI calls send
no `Origin` and are accepted.

### Error responses

```json
{ "error": "E_UNAUTHORIZED" }   // 401 — missing or wrong token
{ "error": "E_BAD_ORIGIN" }     // 403 — disallowed browser origin
```

## GET /health

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7777/health
```

Response 200:

```json
{
  "ok": true,
  "version": "0.0.1",
  "vault_root": "/Users/x/vault",
  "uptime_s": 1234,
  "sessions": 0
}
```

Schema: `HealthResp` in `protocol/src/health.ts`.

## GET /agents

Lists agents under the configured vault.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7777/agents
```

Response 200: `[{name, vault_path}, ...]`.

(Currently un-gated — see Known asymmetry.)

## POST /chats

Create a new chat for an agent.

Body: `{ "agent": "maya" }`

Response 200: `{id, title: null, created_at: number}`.

## GET /chats

Response 200: array of chat rows sorted recent-first.

## GET /chat/:id

Single chat row by id.

## GET /chat/:id/messages

Ordered message list for a chat.

## POST /chat/:id/message

Send a user message; daemon spawns a run.

Body: `{ "content": "hello" }`

## POST /chat/:id/cancel

Cancel the current run.

## POST /chat/:chat_id/answer

Answer a pending `ask_user` task.

## GET /chat/:id/stream  (NEW, this milestone)

Server-Sent Events scoped to one chat.

```bash
curl -N "http://127.0.0.1:7777/chat/$CHAT_ID/stream?token=$TOKEN"
```

Response: `text/event-stream`. Frame format:

```
event: <type>
data: <json>

```

### Event types

| event       | data shape                                                  |
|-------------|-------------------------------------------------------------|
| `hello`     | `{chat_id, version}`                                        |
| `text`      | `{run_id, delta}`                                           |
| `tool_use`  | `{run_id, name, input}` (skipped if `?text_only=1`)         |
| `tool_result` | `{run_id, name, ok}` (skipped if `?text_only=1`)          |
| `ask_user`  | `{run_id, task_id, prompt, options?}`                       |
| `usage`     | `{run_id, input_tokens, output_tokens, cost_usd}`           |
| `run_end`   | `{run_id, status}` — **server closes after this frame**     |
| `error`     | `{message}` — server closes                                 |

### Hello-first contract

Clients MUST wait for the `hello` frame before issuing
`POST /chat/:id/message`. This ensures the SSE subscriber is attached before
the run starts; otherwise opening frames are lost.

Recommended CLI sequence:

```
1. POST /chats         → {id}
2. GET  /chat/:id/stream
3. await hello frame
4. POST /chat/:id/message
5. stream until run_end → exit
```

### Disconnect

Closing the connection unsubscribes the listener server-side. No leaks.

### Errors

- 401 `E_UNAUTHORIZED`
- 403 `E_BAD_ORIGIN`
- 404 `E_NOT_FOUND` (unknown chat_id)

## GET /vault/file?path=<rel>

Read a UTF-8 file under the vault root.

```bash
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7777/vault/file?path=notes/today.md"
```

Response 200: `{path, content, size, mtime}`.

Errors:

| status | code                 | meaning                                   |
|--------|----------------------|-------------------------------------------|
| 400    | E_TRAVERSAL          | Path tries to escape (or is absolute)     |
| 403    | E_OUT_OF_SCOPE       | Resolves outside vault root               |
| 403    | E_EXCLUDED           | Hits .obsidian / .git / dotfile           |
| 404    | E_NOT_FOUND          | Path doesn't exist                        |
| 415    | E_BINARY             | File is not valid UTF-8                   |

## PUT /vault/file

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"path":"notes/today.md","content":"hello"}' \
  http://127.0.0.1:7777/vault/file
```

Body: `{path, content}` (UTF-8 string). Max content size: **10 MB**.

Behavior:
- Creates parent directories.
- Atomic via tmp+rename.
- Rejects symlinked parents that escape vault root.

Response 200: `{path, size, mtime}`.

Errors:

| status | code                |
|--------|---------------------|
| 400    | E_TRAVERSAL         |
| 400    | E_INVALID_BODY      |
| 403    | E_OUT_OF_SCOPE      |
| 403    | E_EXCLUDED          |
| 403    | E_SYMLINK_ESCAPE    |
| 413    | E_TOO_LARGE         |

## GET /vault/list?path=<rel>&depth=<N>

```bash
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7777/vault/list?path=notes&depth=1"
```

- `path` default = vault root.
- `depth` default = 1 (top-level only in v1).

Response 200:

```json
{
  "path": "/abs/under/vault",
  "entries": [
    {"name": "foo.md", "type": "file", "size": 42, "mtime": 1715900000},
    {"name": "sub",    "type": "dir",  "size": 0,  "mtime": 1715900000}
  ]
}
```

Excluded names (`.obsidian`, `.git`, dotfiles) skipped.

## GET /cost/today

Cost rollup for today.

## WS /events

Global daemon event stream — used by plugin. Not gated (legacy
compatibility). Same payload shapes as SSE frames but no `event:` framing —
all sent as JSON-encoded WS messages with a `type` field.

For per-chat consumption, prefer `GET /chat/:id/stream`.

## POST /mcp

MCP JSON-RPC bridge for agent subprocesses. See `daemon/src/adapters/mcp/`.
```

- [ ] **Step 11.2: Commit**

```bash
cd workspace/void-os && git add docs/api.md && git commit -m "docs(VOS-116): docs/api.md — full HTTP surface + auth section"
```

---

## Task 12: Regression sweep + integration smoke

**Goal:** Confirm the milestone shipped no regressions across the existing route/test suites. Run everything green before requesting code review.

- [ ] **Step 12.1: Full daemon test suite**

```bash
cd workspace/void-os/daemon && bun test 2>&1 | tail -40
```

Expected: all green. Pay attention to:

- `chats-routes.test.ts` — should pass; un-gated routes still work.
- `chat-messages.test.ts` — same.
- `ws-handshake.test.ts`, `ws-events.test.ts` — still pass; WS path untouched.
- `app-wiring.test.ts` — passes with updated assertions.
- `mcp-hono-bridge.test.ts` — `/mcp` untouched.

If any fail because `/health` now needs a token: add the header at the call site. Cite the exact failure first; do not silently work around it.

- [ ] **Step 12.2: Protocol test suite**

```bash
cd workspace/void-os/protocol && bun test
```

Expected: green.

- [ ] **Step 12.3: Typecheck daemon + protocol**

```bash
cd workspace/void-os/daemon && bun run typecheck
cd workspace/void-os/protocol && bun run typecheck
```

Expected: no errors. Fix any new strict-null or type-mismatch issues inline.

- [ ] **Step 12.4: Manual one-shot smoke via curl (no LLM call needed)**

This validates wiring without invoking Claude. From the worktree:

```bash
# Start daemon in background.
cd workspace/void-os/daemon && bun run src/index.ts &
DAEMON_PID=$!
sleep 1
TOKEN=$(cat ~/.void-os/token)

# /health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7777/health | jq

# /vault/list (vault root)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7777/vault/list" | jq

# /vault/file write + read
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"path":"smoke.md","content":"hello from VOS-116"}' \
  http://127.0.0.1:7777/vault/file | jq
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7777/vault/file?path=smoke.md" | jq

# Cleanup
kill $DAEMON_PID
```

Expected:
- `/health` returns extended shape with `vault_root` + `uptime_s`.
- `/vault/list` returns vault root entries.
- PUT then GET round-trips `"hello from VOS-116"`.
- No daemon crash. Token file at `~/.void-os/token` mode 0600.

- [ ] **Step 12.5: Commit any test-fixup needed**

If Step 12.1 forced you to update existing test call sites for the `/health` auth gate:

```bash
cd workspace/void-os && git add daemon/test/ && git commit -m "test(VOS-116): pass Authorization on /health calls in legacy tests"
```

- [ ] **Step 12.6: Hand off**

Final state to verify before declaring task complete:
- All daemon + protocol tests green.
- `docs/api.md` exists and is complete.
- Token file exists at `~/.void-os/token`, mode 0600.
- Branch `task/VOS-116` has a clean history of feature/test commits, no force-pushes.

Orchestrator then runs `superpowers:requesting-code-review` across the full branch and verifies each task-file `## Acceptance` bullet. Push happens via `/done`, not in this task.

---

## Self-Review Notes

**Spec coverage check:** Acceptance bullets from the task file (and the spec's `## Acceptance`) all map:

- Endpoint to spawn + one-shot blocking → resolved by Q5 (no new endpoint; use existing `POST /chats` + `POST /chat/:id/message` + SSE). Documented in `docs/api.md` § "Hello-first contract". Covered by existing tests + Task 10.
- Streaming chat session (SSE) → Task 10.
- Endpoint to list agents → existing `/agents` (documented in Task 11).
- Vault read/write/list → Tasks 7/8/9.
- Health with daemon status + vault root + version → Task 5.
- All endpoints documented in `docs/api.md` → Task 11.
- No regression in plugin → Task 12 regression sweep + un-gated existing routes.
- TS types via `protocol/` → Tasks 1, 7, 10.

**Placeholder scan:** none. All code blocks are concrete. The one judgement call deferred to execution time is the workspace-vs-tsconfig-alias fallback in Step 1.13 — but that fallback is fully specified.

**Type consistency:** `VaultWriteReq.path` is `z.string().min(1)`; tests assert empty path → 400. `EventBus.listenerCount()` defined in Task 2, used in Task 10 — same name. `HealthResp` shape matches Task 5 implementation.

**Known known:** Task 10's "wait until closed" busy-poll (`setInterval(50ms)` in chat-stream.ts) is intentionally simple; could become a Promise-based wait if the busy-poll shows up in CPU profiles. Not optimized in v1.
