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

## CLI (`void-os`)

Install once from `workspace/void-os/`:

```sh
bun link
```

State files under `~/.void-os/`:

| File | Written by | Purpose |
|------|------------|---------|
| `token` | daemon `ensureToken()` | bearer auth |
| `daemon.pid` | `void-os daemon start` | PID for liveness + stop |
| `daemon.port` | `void-os daemon start` | port for subsequent CLI calls |
| `daemon.log` | `void-os daemon start` (stdout+stderr redirect) | tailable log |

Environment overrides:

- `VOID_OS_BASE` — daemon URL (default `http://127.0.0.1:<daemon.port>` or `:7777`)
- `VOID_OS_TOKEN` — auth token (default `~/.void-os/token`)
- `VOID_OS_PREFIX` — repo prefix (defaults to dir of `bin/void-os`)
- `VOID_OS_PORT` — default port for `daemon start` (default 7777)
- `VOID_OS_VAULT_ROOT` — default vault for `daemon start`

Exit codes (stable contract):

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | runtime error (daemon reachable but operation failed; bad input data) |
| 2 | usage error (bad flags, missing positional, unknown command) |
| 3 | daemon unreachable (network refused, missing port file, no token) |

Subcommand surface (VOS-117): `daemon {start, stop, status, logs}`, `agents list`, `vault {read, write, list}`, `plugin {install, status}`, `init` (pre-existing). `ask` and `chat` ship in VOS-118.
