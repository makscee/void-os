---
task: VOS-116
title: Daemon HTTP API for CLI clients — design
created: 2026-05-17
status: draft
---

# VOS-116 — Daemon HTTP API for CLI clients

## Context

The void-os daemon (Bun + Hono on `127.0.0.1:7777`) today serves the Obsidian plugin. To make the CLI (VOS-117/118) a first-class client, the daemon needs HTTP/SSE endpoints with no plugin-specific assumptions, plus a shared `protocol/` package both clients consume.

This is **Stream A foundation** of the `vos-cli-support` milestone — every later stream depends on the contract defined here.

### Existing routes (unchanged by this task)

| Route | Method | Source |
|---|---|---|
| `/` | GET | `daemon/src/app.ts` |
| `/health` | GET | `daemon/src/api/index.ts` (modified by this task) |
| `/agents` | GET | `daemon/src/api/agents.ts` |
| `/chats` | GET, POST | `daemon/src/api/chats.ts` |
| `/chat/:id` | GET | `daemon/src/api/chat.ts` |
| `/chat/:id/messages` | GET | `daemon/src/api/chat.ts` |
| `/chat/:id/message` | POST | `daemon/src/api/chat.ts` |
| `/chat/:id/cancel` | POST | `daemon/src/api/chat.ts` |
| `/chat/:chat_id/answer` | POST | `daemon/src/api/answer.ts` |
| `/cost/today` | GET | `daemon/src/api/cost.ts` |
| `/mcp` | POST | hono-bridge |
| `/events` | WebSocket | `daemon/src/app.ts` (`wsHandler`) |

Plugin continues to use `/events` global WS; not migrated in this task.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| Q1 | CLI `ask` = async handle + stream; no blocking endpoint | Symmetric with `chat`, streams deltas, single transport |
| Q2 | Per-chat streaming = SSE (one new route) | CLI-friendly, plugin keeps global WS untouched |
| Q3 | Vault ops = REST routes reusing `resolveVaultPath`; drop per-agent allowlist; keep vault-root containment | HTTP caller is operator, not agent — layer 2 scope unnecessary |
| Q4 | `protocol/` = types + zod schemas; no client helpers; Bun workspaces | Daemon already uses zod ^4.4.3; types-only invites silent drift |
| Q5 | No `/ask` endpoint; `ask` is CLI sugar over `POST /chats` + `POST /chat/:id/message` + SSE | Daemon doesn't care; persistence always on for v1 |
| Forge-1 | Bearer-token + Origin check on all new routes | Loopback ≠ trusted (DNS rebinding, shared Mac) |
| Forge-3 | CLI ordering: open SSE before send-message | Eliminates subscribe-after-send frame loss |
| Forge-4 | PUT /vault/file: 10 MB cap + tmp+rename atomic + realpath check + exclude list | Prevent symlink escape, mid-write truncation, OOM |

## Scope

### NEW routes

- `GET /chat/:id/stream` — SSE, per-chat scoped events.
- `GET /vault/file?path=…` — read.
- `PUT /vault/file` — write (body `{path, content}`).
- `GET /vault/list?path=…&depth=N` — list.

### MODIFIED routes

- `GET /health` — add `vault_root`, `uptime_s`. Now requires auth (leaks vault_root).

### NEW infrastructure

- `protocol/` workspace package — shared zod schemas + inferred types.
- `~/.void-os/token` — daemon-issued bearer token, 32-byte hex, file mode `0600`.
- `docs/api.md` — single source-of-truth endpoint reference.
- `EventBus.listenerCount()` — new method, used by leak tests.

### Non-goals

- No `/ask` endpoint.
- No ephemeral chats.
- No CLI client helpers in `protocol/` (deferred to VOS-117).
- No plugin migration to per-chat SSE (deferred).
- No replay buffer (CLI ordering fix obviates).
- No binary file support in `/vault/file` (returns 415; future task may add base64).
- No `If-Match` / `ETag` concurrency control on PUT (last-write-wins).

## § 1 — Auth posture

### Token issuance

On daemon boot (`daemon/src/index.ts`, before `Bun.serve`):

```ts
const tokenPath = path.join(os.homedir(), ".void-os", "token");
if (!fs.existsSync(tokenPath)) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
}
const TOKEN = fs.readFileSync(tokenPath, "utf8").trim();
```

Token is loaded once at boot. Rotation = delete the file + restart daemon.

### Enforcement

Hono middleware applied to **all new routes** + the modified `/health`:

```ts
const requireAuth: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return c.json({ error: "E_BAD_ORIGIN" }, 403);
  }
  const supplied = bearerFrom(c.req.header("Authorization")) ?? c.req.query("token");
  if (supplied !== TOKEN) return c.json({ error: "E_UNAUTHORIZED" }, 401);
  await next();
};
```

- `ALLOWED_ORIGINS`: `null` / undefined Origin allowed (CLI, server-to-server). Browser Origins rejected unless on allowlist (initially empty; plugin doesn't use these routes).
- SSE accepts `?token=` query because `EventSource` cannot set headers; CLI uses Bun `fetch` and sends `Authorization`.

### Routes NOT gated

Existing routes (`/chats`, `/chat/*`, `/agents`, `/events`, `/mcp`, `/cost/today`) stay open for plugin backward compatibility. **Tracked in spec as known asymmetry** — full enforcement is a follow-up milestone task.

### Wire shape

- 401 `{error: "E_UNAUTHORIZED"}` for missing/bad token.
- 403 `{error: "E_BAD_ORIGIN"}` for disallowed browser origin.

## § 2 — Per-chat SSE: `GET /chat/:id/stream`

### Headers

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `X-Accel-Buffering: no` (for future reverse-proxy)
- Bun `idleTimeout: 255` already configured for `/events`; SSE reuses same server.

### Frame format

```
event: <type>
data: <json>

```

Trailing blank line per SSE spec.

### Event types

| Event | Data shape | Notes |
|---|---|---|
| `hello` | `{chat_id, version}` | First frame; sent immediately on subscribe |
| `text` | `{run_id, delta: string}` | Token deltas |
| `tool_use` | `{run_id, name, input}` | Skipped if `?text_only=1` |
| `tool_result` | `{run_id, name, ok: bool}` | Skipped if `?text_only=1` |
| `ask_user` | `{run_id, task_id, prompt, options?}` | Mirrors plugin's ask-user-bridge |
| `usage` | `{run_id, input_tokens, output_tokens, cost_usd}` | Per-run |
| `run_end` | `{run_id, status}` | **Server closes after this frame** |
| `error` | `{message}` | Server closes |

### Lifecycle (load-bearing — addresses Forge #2)

1. Client opens stream with `?token=…`.
2. Auth middleware validates.
3. Server validates `chat_id` exists in `chats` table → 404 if not.
4. Server subscribes to `EventBus` with predicate `event.chat_id === chatId`.
5. Server immediately writes `hello` frame.
6. **Close condition:** ANY frame whose `event.type === "run_end" && event.chat_id === chatId` flushes + closes the stream. Not pinned to `current_run_id` at subscribe time (avoids stale-pin race).
7. Server uses Hono `streamSSE` with `onAbort` to unsubscribe on client disconnect.
8. EventBus subscriber count is asserted to return to pre-subscribe baseline post-close in tests.

### `hello`-first contract (addresses Forge #3)

CLI flow becomes:

```
POST /chats               → {id}
GET  /chat/:id/stream     → (open SSE, await `hello` frame)
POST /chat/:id/message    → (run starts; deltas stream over the already-open SSE)
                          → … eventually `run_end` → CLI exits
```

The `hello` frame is the synchronization point. The send-message call must not be issued until the client has consumed `hello`. Documented in `docs/api.md`.

### No replay

If a client disconnects mid-run and reconnects, they get only new frames from that point. No buffer. Plugin already operates this way on `/events`.

## § 3 — Vault routes

All three routes:
- Gated by auth middleware (§ 1).
- Share `resolveVaultPath(vaultRoot, path)` from `daemon/src/vault/paths.ts`.
- Return JSON; errors as `{error: ERR_CODE}` with appropriate status.
- Echo the resolved absolute path in success responses.

### Error codes

| Code | Status | Meaning |
|---|---|---|
| `E_NOT_FOUND` | 404 | Path doesn't exist |
| `E_OUT_OF_SCOPE` | 403 | Resolves outside `vaultRoot` |
| `E_TRAVERSAL` | 400 | Path contains `..` segments that escape |
| `E_BINARY` | 415 | File is not valid UTF-8 |
| `E_EXCLUDED` | 403 | Path matches exclusion list (`.obsidian/`, `.git/`, dotfiles) |
| `E_SYMLINK_ESCAPE` | 403 | Symlink target escapes vaultRoot |
| `E_TOO_LARGE` | 413 | Body exceeds 10 MB cap |
| `E_INVALID_BODY` | 400 | Zod parse failure |

### `GET /vault/file?path=relative/or/abs`

Response 200:
```json
{ "path": "/abs/under/vault/foo.md", "content": "...", "size": 123, "mtime": 1715900000 }
```

Reads via `fs.promises.readFile(absPath, "utf8")`. UTF-8 validation: if `Buffer.isUtf8` fails, return 415 `E_BINARY`. Excluded paths (`.obsidian/`, `.git/`, dotfiles at any level) return 403 `E_EXCLUDED`.

### `PUT /vault/file` (hardened per Forge #4)

Request body (zod):
```ts
const VaultWriteReq = z.object({
  path: z.string(),
  content: z.string().max(10 * 1024 * 1024),  // 10 MB cap (E_TOO_LARGE)
});
```

Also enforced at HTTP layer: reject request if `Content-Length` exceeds 10 MB (early 413 before reading body).

Steps:
1. Parse + validate body → 400 / 413 on failure.
2. Resolve path via `resolveVaultPath` → 4xx on scope error.
3. Apply exclusion list (same as `/vault/list`) → 403 `E_EXCLUDED` for matches.
4. **Realpath check on target** — if file exists, `fs.realpathSync(absPath)` must still be under `vaultRoot`. If parent exists, `realpathSync(dirname(absPath))` must be under `vaultRoot`. Both protect against symlink escape.
5. `fs.mkdirSync(dirname(absPath), { recursive: true })` for parents (only after realpath check passes).
6. **Atomic write:** write to `${absPath}.tmp-${pid}-${rand}` then `fs.renameSync` to final path. No partial files on crash.
7. Return `{path, size, mtime}` 200.

### `GET /vault/list?path=subdir&depth=N`

Query:
- `path` — relative or absolute (default = vaultRoot itself).
- `depth` — integer ≥ 1, or `Infinity` if omitted. Recurse stops at this depth.

Response 200:
```json
{
  "path": "/abs/under/vault",
  "entries": [
    { "name": "notes", "type": "dir", "size": 0, "mtime": 1715900000 },
    { "name": "foo.md", "type": "file", "size": 123, "mtime": 1715900000 }
  ]
}
```

Excluded names (`.obsidian`, `.git`, anything starting with `.`) skipped during traversal. Per-dir entries sorted alphabetically.

## § 4 — `protocol/` package

### Layout

```
workspace/void-os/protocol/
  package.json          # name: "@voidos/protocol"
  tsconfig.json
  src/
    index.ts            # re-exports
    chats.ts            # CreateChatReq, ChatRow
    chat-messages.ts    # SendMessageReq, MessageRow
    chat-stream.ts      # StreamEvent discriminated union
    vault.ts            # VaultReadResp, VaultWriteReq, VaultListResp, VAULT_ERR
    agents.ts           # AgentListEntry
    health.ts           # HealthResp
    events.ts           # WS frame types (lifted from daemon)
    auth.ts             # AuthError codes
  test/
    schemas.test.ts     # round-trip fixtures, discriminated-union strictness
```

### Root `package.json`

Add `workspaces: ["daemon", "plugin", "protocol"]` (verify Bun workspaces field if not already present).

Daemon + plugin `package.json`: add `"@voidos/protocol": "workspace:*"` to `dependencies`.

### Smoke step (mandatory before scaling out — addresses Forge Risk #1)

After `bun install`:
- Import `{ HealthResp }` from `@voidos/protocol` in `daemon/src/app.ts`.
- Run `bun test daemon/test/app-wiring.test.ts`.
- If it fails to resolve: drop the workspace-package approach, fall back to **path-aliased tsconfig** (`compilerOptions.paths`: `"@voidos/protocol": ["../protocol/src"]`). Types only, no runtime; daemon imports `.parse()` from a local shim re-exporting zod schemas.

This is a hard checkpoint in the implementation plan — failure here forks the work.

### Schema style

Schemas exported as zod objects, with `z.infer` types exported alongside:

```ts
export const VaultReadResp = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int(),
  mtime: z.number().int(),
});
export type VaultReadResp = z.infer<typeof VaultReadResp>;
```

Daemon usage:
```ts
const body = VaultWriteReq.parse(await c.req.json());  // throws → caught → 400
return c.json({ path, size, mtime } satisfies VaultWriteResp);
```

### Discriminated unions for SSE

```ts
const TextFrame = z.object({ event: z.literal("text"), data: TextData });
// …
export const StreamFrame = z.discriminatedUnion("event", [TextFrame, /* … */]);
```

Tests assert `StreamFrame.parse({event: "weird"})` rejects.

### Plugin migration

Out of scope for VOS-116. Plugin keeps current ad-hoc types. Touching plugin files in this task is allowed only where unavoidable (e.g. adding `@voidos/protocol` to `plugin/package.json`).

## § 5 — `/health` extension

Current shape: `{ok, version, sessions: 0}`.

New shape:
```json
{
  "ok": true,
  "version": "0.0.1",
  "vault_root": "/Users/admin/hub/workspace/void-os/vault-starter",
  "uptime_s": 1234,
  "sessions": 0
}
```

- `vault_root`: absolute path captured at boot.
- `uptime_s`: `Math.floor((Date.now() - bootTime) / 1000)`.

Backwards compatible at the field level, but **now gated by auth** (vault_root leaks). Plugin currently doesn't read `/health` programmatically; if it starts to, it must pass a token.

## § 6 — `docs/api.md`

Single doc, one section per endpoint. Order:

1. Authentication (token discovery, Authorization header, `?token=`)
2. `GET /health`
3. `GET /agents`
4. `GET /chats`, `POST /chats`
5. `GET /chat/:id`, `GET /chat/:id/messages`, `POST /chat/:id/message`, `POST /chat/:id/cancel`, `POST /chat/:chat_id/answer`
6. `GET /chat/:id/stream` — full SSE event catalog
7. `GET /vault/file`, `PUT /vault/file`, `GET /vault/list`
8. `GET /cost/today`
9. `WS /events` — global event stream
10. `POST /mcp` — pointer to MCP spec

Each section:
- Method + path
- Request body schema (link to `protocol/src/<file>.ts`)
- Response schema (link)
- Error codes table
- `curl` example with token

## § 7 — Testing

### Daemon (`daemon/test/`)

- `vault-routes.test.ts` (new)
  - Resolves under vaultRoot: 200.
  - Path with `../../..`: 400 `E_TRAVERSAL`.
  - Absolute path outside vault: 403 `E_OUT_OF_SCOPE`.
  - Read non-existent: 404.
  - Read binary file: 415 `E_BINARY`.
  - Exclude `.obsidian/`, `.git/`, dotfiles: 403 `E_EXCLUDED`.
  - PUT body > 10 MB: 413 `E_TOO_LARGE`.
  - PUT to path via symlink escaping vaultRoot: 403 `E_SYMLINK_ESCAPE`.
  - PUT round-trip: write, read back, content matches.
  - PUT atomicity: SIGKILL mid-write (simulated by failing rename) leaves no partial file at final path.
  - List depth=1 shallow, depth=Infinity recursive, excludes correct.

- `chat-stream.test.ts` (new)
  - Open SSE, assert `hello` frame first.
  - Send message via `POST /chat/:id/message` after `hello` received.
  - Assert frame order: `text` → `usage` → `run_end`.
  - Server closes connection after `run_end`.
  - Client disconnect mid-run: assert `EventBus.listenerCount()` returns to baseline.
  - 404 on unknown `chat_id`.
  - Missing token → 401.
  - Bad Origin → 403.

- `app-wiring.test.ts` (modified)
  - `/health` response includes `vault_root` (string) and `uptime_s` (number).
  - `/health` without token → 401.

- `auth-middleware.test.ts` (new)
  - Token via Authorization header accepted.
  - Token via `?token=` accepted (for SSE).
  - Missing token → 401.
  - Wrong token → 401.
  - Disallowed Origin → 403.
  - No Origin (CLI) → allowed.

### Protocol (`protocol/test/`)

- `schemas.test.ts` (new)
  - For each exported schema: parse a known-good fixture, succeed.
  - Discriminated union rejects unknown `event` value.
  - VaultWriteReq rejects `content` > 10 MB.

### Regression (must remain green)

- `chats-routes.test.ts`, `chat-messages.test.ts`, `ws-events.test.ts`, `ws-handshake.test.ts`, `chat-flow.test.ts`, `chat-cancel.test.ts`, `ask-agent.test.ts`, `chat/orchestrator-*.test.ts`, `chat/repo.test.ts`, `chat/messages-repo.test.ts`.

### Not in scope

No E2E for CLI. CLI E2E lives in VOS-117/118/121. VOS-116 ships HTTP surface only.

## § 8 — Risks + mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Bun `workspace:*` resolution fails on first attempt | Smoke step gates scale-out; fallback to tsconfig path-alias documented (§ 4) |
| R2 | EventBus has no `listenerCount()` API today | Add it as part of this task. Tracked as explicit subtask. |
| R3 | SSE behind proxy buffers frames | `X-Accel-Buffering: no` header included; non-issue for localhost daemon |
| R4 | Plugin breaks if `/health` gates auth | Plugin doesn't currently call `/health`. Verify via grep before merge. |
| R5 | Token file readable by other local users on shared Mac | File mode `0600` + parent dir `0700`. Multi-user-Mac users still need OS file perms; documented. |
| R6 | Existing routes remain unauthed; partial-auth state is confusing | Spec section + `docs/api.md` flags this asymmetry as known. Follow-up task to gate all routes deferred. |
| R7 | CLI ordering bug if implementer skips `hello` wait | Spec mandates `hello`-first contract; `chat-stream.test.ts` asserts ordering; `docs/api.md` calls it out. |

## Acceptance (mirrors task file)

- [ ] `POST /chats` + `POST /chat/:id/message` + `GET /chat/:id/stream` together support one-shot ask flow (`hello`-first contract documented).
- [ ] `GET /chat/:id/stream` streams SSE events scoped to one chat; closes on `run_end`.
- [ ] `GET /agents` (already serves) covered in `docs/api.md`.
- [ ] `GET /vault/file`, `PUT /vault/file`, `GET /vault/list` ship with hardening: scope guard, exclusion list, size cap, atomic write, symlink check.
- [ ] `GET /health` returns `{ok, version, vault_root, uptime_s, sessions}`.
- [ ] All new + modified routes gated by bearer-token + Origin check; token at `~/.void-os/token` mode 0600.
- [ ] All endpoints documented in `docs/api.md` with request/response shapes + error codes + curl examples.
- [ ] No regression in plugin behavior — existing tests stay green; plugin still uses untouched `/events` WS.
- [ ] TS types + zod schemas shared via `@voidos/protocol` workspace package (consumed by daemon; plugin opportunistic).
- [ ] `EventBus.listenerCount()` exists; SSE leak test asserts post-disconnect baseline.
