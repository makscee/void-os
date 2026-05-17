# VOS-117 — CLI scaffold (daemon control + introspection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `void-os` CLI binary with foundation subcommands (daemon lifecycle, agents list, vault ops, plugin install) and a typed protocol/ HTTP client so VOS-118 can layer `ask`/`chat` on top.

**Architecture:** Each `cli/<cmd>.ts` owns its subcommand router. Shared HTTP client lives in `protocol/`. State files (`token`, `daemon.pid`, `daemon.port`, `daemon.log`) live under `~/.void-os/`. `daemon start` detaches via `child_process.spawn(detached:true)`, redirecting stdio to the log file; blocks until `/health` returns 200 (10 s timeout) with early-exit on child death. `daemon stop` verifies via `/health` before signaling (anti-PID-recycle).

**Tech Stack:** Bun 1.3, Hono, Zod, bun:test, TypeScript ESM. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-17-VOS-117-cli-scaffold-design.md`

---

## File map

| File | Action | Owner task |
|------|--------|------------|
| `workspace/void-os/package.json` | add `"bin": { "void-os": "./bin/void-os" }` | T0 |
| `workspace/void-os/protocol/src/agents.ts` | new | T1 |
| `workspace/void-os/protocol/src/index.ts` | re-export agents + client | T1, T2 |
| `workspace/void-os/protocol/test/agents.test.ts` | new | T1 |
| `workspace/void-os/protocol/src/client.ts` | new | T2 |
| `workspace/void-os/protocol/test/client.test.ts` | new | T2 |
| `workspace/void-os/cli/lib/args.ts` | new | T3 |
| `workspace/void-os/cli/lib/args.test.ts` | new | T3 |
| `workspace/void-os/cli/lib/output.ts` | new | T4 |
| `workspace/void-os/cli/lib/output.test.ts` | new | T4 |
| `workspace/void-os/cli/lib/state-dir.ts` | new | T5 |
| `workspace/void-os/cli/lib/state-dir.test.ts` | new | T5 |
| `workspace/void-os/cli/lib/client.ts` | new | T6 |
| `workspace/void-os/bin/void-os` | rewrite dispatcher | T7 |
| `workspace/void-os/cli/daemon.ts` | rewrite — start/stop/status/logs | T8–T11 |
| `workspace/void-os/cli/daemon.test.ts` | new — lifecycle integration | T8–T11 |
| `workspace/void-os/cli/agents.ts` | new | T12 |
| `workspace/void-os/cli/agents.test.ts` | new | T12 |
| `workspace/void-os/cli/vault.ts` | new | T13–T15 |
| `workspace/void-os/cli/vault.test.ts` | new | T13–T15 |
| `workspace/void-os/cli/plugin.ts` | new | T16–T17 |
| `workspace/void-os/cli/plugin.test.ts` | new | T16–T17 |
| `workspace/void-os/docs/api.md` | append `~/.void-os/` paths + CLI exit codes table | T18 |

---

## Task 0: `bun link` spike + register bin

**Why first:** The whole CLI install story hinges on `bun link` working from the workspace root. Forge issue #4. Cheap to verify; if broken, fall back to per-workspace bin before any code lands.

**Files:**
- Modify: `workspace/void-os/package.json`

- [ ] **Step 1: Inspect current `package.json`**

```bash
cat workspace/void-os/package.json
```

Expected: `{"name":"void-os","private":true,"type":"module","workspaces":["daemon","plugin","protocol"]}`.

- [ ] **Step 2: Add `bin` field**

Edit `workspace/void-os/package.json`:

```json
{
  "name": "void-os",
  "private": true,
  "type": "module",
  "bin": { "void-os": "./bin/void-os" },
  "workspaces": ["daemon", "plugin", "protocol"]
}
```

- [ ] **Step 3: Run `bun link` from workspace root**

```bash
cd workspace/void-os && bun link
```

Expected: bun prints "Success! Registered \"void-os\"".

- [ ] **Step 4: Verify from a fresh shell**

```bash
zsh -c 'which void-os && void-os --help; echo exit=$?'
```

Expected: a path inside bun's global bin (typically `~/.bun/bin/void-os`). `--help` will currently fail because the existing dispatcher doesn't recognize `--help` for the root — that's fine for now. Exit code may be 1 or 2.

If `which void-os` returns nothing: STOP and update the spec — fall back is per-workspace bin in `daemon/package.json` or a manual install script. Do not proceed to T1 until install works.

- [ ] **Step 5: Tear down**

```bash
cd workspace/void-os && bun unlink
```

- [ ] **Step 6: Commit**

```bash
cd workspace/void-os
git add package.json
git commit -m "feat(VOS-117): register \`void-os\` bin in workspace root package.json"
```

Log the spike outcome (which path, fresh-shell verdict) for the task Work Log.

---

## Task 1: Protocol `agents` schema

**Files:**
- Create: `workspace/void-os/protocol/src/agents.ts`
- Modify: `workspace/void-os/protocol/src/index.ts`
- Create: `workspace/void-os/protocol/test/agents.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/protocol/test/agents.test.ts`:

```ts
import { test, expect } from "bun:test";
import { AgentListEntry, AgentsListResp } from "../src/agents.ts";

test("AgentListEntry accepts daemon row", () => {
  expect(() => AgentListEntry.parse({ name: "maya", description: "default agent" })).not.toThrow();
});

test("AgentListEntry allows empty description", () => {
  expect(() => AgentListEntry.parse({ name: "x", description: "" })).not.toThrow();
});

test("AgentListEntry rejects missing name", () => {
  expect(() => AgentListEntry.parse({ description: "x" })).toThrow();
});

test("AgentsListResp wraps a list", () => {
  expect(() => AgentsListResp.parse({ agents: [{ name: "a", description: "" }] })).not.toThrow();
  expect(() => AgentsListResp.parse({ agents: [] })).not.toThrow();
});

test("AgentsListResp rejects non-array agents", () => {
  expect(() => AgentsListResp.parse({ agents: "no" })).toThrow();
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd workspace/void-os/protocol && bun test test/agents.test.ts
```

Expected: FAIL — `src/agents.ts` does not exist.

- [ ] **Step 3: Implement schema**

Create `workspace/void-os/protocol/src/agents.ts`:

```ts
import { z } from "zod";

export const AgentListEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type AgentListEntry = z.infer<typeof AgentListEntry>;

export const AgentsListResp = z.object({
  agents: z.array(AgentListEntry),
});
export type AgentsListResp = z.infer<typeof AgentsListResp>;
```

- [ ] **Step 4: Re-export from index**

Append to `workspace/void-os/protocol/src/index.ts`:

```ts
export * from "./agents.ts";
```

- [ ] **Step 5: Run test, verify it passes**

```bash
cd workspace/void-os/protocol && bun test test/agents.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 6: Daemon smoke — verify shape matches real route**

```bash
cd workspace/void-os && bun test daemon/test/protocol-smoke.test.ts
```

Expected: existing daemon smoke still passes.

- [ ] **Step 7: Commit**

```bash
cd workspace/void-os
git add protocol/src/agents.ts protocol/src/index.ts protocol/test/agents.test.ts
git commit -m "feat(VOS-117): protocol AgentListEntry + AgentsListResp"
```

---

## Task 2: Protocol HTTP client

**Files:**
- Create: `workspace/void-os/protocol/src/client.ts`
- Modify: `workspace/void-os/protocol/src/index.ts`
- Create: `workspace/void-os/protocol/test/client.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/protocol/test/client.test.ts`:

```ts
import { test, expect } from "bun:test";
import { makeClient, ApiError, ServerError, UnreachableError } from "../src/client.ts";

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return Promise.resolve(handler(req));
  };
}

test("health() sends bearer + parses HealthResp", async () => {
  let seen: Request | null = null;
  const client = makeClient({
    base: "http://x",
    token: "tok",
    fetch: fakeFetch((req) => {
      seen = req;
      return new Response(
        JSON.stringify({ ok: true, version: "0.0.1", vault_root: "/v", uptime_s: 1, sessions: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });
  const h = await client.health();
  expect(h.version).toBe("0.0.1");
  expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  expect(new URL(seen!.url).pathname).toBe("/health");
});

test("agents.list() returns parsed list", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response(JSON.stringify({ agents: [{ name: "maya", description: "d" }] }), { status: 200, headers: { "content-type": "application/json" } })),
  });
  const r = await client.agents.list();
  expect(r.agents.length).toBe(1);
});

test("vault.write() sends JSON body", async () => {
  let body: any = null;
  let ct: string | null = null;
  let method: string | null = null;
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(async (req) => {
      method = req.method;
      ct = req.headers.get("content-type");
      body = await req.json();
      return new Response(JSON.stringify({ path: "p", size: 5, mtime: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  });
  const r = await client.vault.write("notes.md", "hello");
  expect(method).toBe("PUT");
  expect(ct).toContain("application/json");
  expect(body).toEqual({ content: "hello" });
  expect(r.size).toBe(5);
});

test("4xx throws ApiError with code + status", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response(JSON.stringify({ error: "E_NOT_FOUND", message: "missing" }), { status: 404, headers: { "content-type": "application/json" } })),
  });
  await expect(client.vault.read("nope")).rejects.toMatchObject({ name: "ApiError", status: 404, code: "E_NOT_FOUND" });
});

test("5xx throws ServerError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: fakeFetch(() => new Response("boom", { status: 500 })),
  });
  await expect(client.health()).rejects.toMatchObject({ name: "ServerError", status: 500 });
});

test("network failure throws UnreachableError", async () => {
  const client = makeClient({
    base: "http://x",
    token: "t",
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  });
  await expect(client.health()).rejects.toMatchObject({ name: "UnreachableError" });
});

test("ApiError, ServerError, UnreachableError are distinct classes", () => {
  expect(new ApiError("E_X", "m", 400)).toBeInstanceOf(ApiError);
  expect(new ServerError(500, "x")).toBeInstanceOf(ServerError);
  expect(new UnreachableError(new Error("e"))).toBeInstanceOf(UnreachableError);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd workspace/void-os/protocol && bun test test/client.test.ts
```

Expected: FAIL — `src/client.ts` does not exist.

- [ ] **Step 3: Implement client**

Create `workspace/void-os/protocol/src/client.ts`:

```ts
import { HealthResp } from "./health.ts";
import { AgentsListResp } from "./agents.ts";
import { z } from "zod";

// Loose envelopes — daemon owns the source of truth. Tighten if/when needed.
const VaultFileResp = z.object({ path: z.string(), content: z.string(), sha256: z.string().optional(), size: z.number().optional() }).passthrough();
// Verified against daemon/src/api/vault.ts PUT /vault/file — returns {path, content, size, mtime}.
const VaultWriteResp = z.object({ path: z.string(), size: z.number().nonnegative(), mtime: z.number() }).passthrough();
// Verified against daemon/src/api/vault.ts GET /vault/list — returns {path, entries:[{name,type,size,mtime}]}.
const VaultListEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().nonnegative(),
  mtime: z.number(),
});
const VaultListResp = z.object({ path: z.string(), entries: z.array(VaultListEntry) }).passthrough();
export type VaultFileResp = z.infer<typeof VaultFileResp>;
export type VaultWriteResp = z.infer<typeof VaultWriteResp>;
export type VaultListResp = z.infer<typeof VaultListResp>;

export class ApiError extends Error {
  readonly name = "ApiError" as const;
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}
export class ServerError extends Error {
  readonly name = "ServerError" as const;
  constructor(public readonly status: number, public readonly body: string) {
    super(`server error ${status}: ${body.slice(0, 200)}`);
  }
}
export class UnreachableError extends Error {
  readonly name = "UnreachableError" as const;
  constructor(public readonly cause: unknown) {
    super(`daemon unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface ClientOpts {
  base: string;
  token: string;
  fetch?: typeof fetch;
}

export interface Client {
  health(): Promise<HealthResp>;
  agents: { list(): Promise<AgentsListResp> };
  vault: {
    read(path: string): Promise<VaultFileResp>;
    write(path: string, content: string): Promise<VaultWriteResp>;
    list(path?: string, opts?: { depth?: number }): Promise<VaultListResp>;
  };
  chat: { stream(chatId: string): AsyncIterable<unknown> };
}

export function makeClient(opts: ClientOpts): Client {
  const f = opts.fetch ?? fetch;
  const base = opts.base.replace(/\/$/, "");

  async function call<T extends z.ZodTypeAny>(
    pathname: string,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = `${base}${pathname}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${opts.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    let res: Response;
    try {
      res = await f(url, { ...init, headers });
    } catch (e) {
      throw new UnreachableError(e);
    }
    if (res.status >= 500) {
      throw new ServerError(res.status, await res.text());
    }
    if (res.status >= 400) {
      let body: any = null;
      try { body = await res.json(); } catch { body = { error: "E_UNKNOWN", message: await res.text() }; }
      throw new ApiError(String(body.error ?? "E_UNKNOWN"), String(body.message ?? ""), res.status);
    }
    return schema.parse(await res.json());
  }

  async function* sseFrames(pathname: string): AsyncIterable<unknown> {
    const url = `${base}${pathname}`;
    const headers = new Headers({ Authorization: `Bearer ${opts.token}` });
    let res: Response;
    try {
      res = await f(url, { headers });
    } catch (e) {
      throw new UnreachableError(e);
    }
    if (!res.ok || !res.body) {
      throw new ApiError("E_STREAM", `stream failed (status ${res.status})`, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        try { yield JSON.parse(json); } catch { /* skip malformed */ }
      }
    }
  }

  return {
    health: () => call("/health", { method: "GET" }, HealthResp),
    agents: { list: () => call("/agents", { method: "GET" }, AgentsListResp) },
    vault: {
      read: (path) => call(`/vault/file?path=${encodeURIComponent(path)}`, { method: "GET" }, VaultFileResp),
      write: (path, content) =>
        call(`/vault/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ content }) }, VaultWriteResp),
      list: (path, lopts) => {
        const params = new URLSearchParams();
        if (path) params.set("path", path);
        if (lopts?.depth != null) params.set("depth", String(lopts.depth));
        const qs = params.toString();
        return call(`/vault/list${qs ? `?${qs}` : ""}`, { method: "GET" }, VaultListResp);
      },
    },
    chat: { stream: (chatId) => sseFrames(`/chat/${encodeURIComponent(chatId)}/stream`) },
  };
}
```

- [ ] **Step 4: Re-export from index**

Append to `workspace/void-os/protocol/src/index.ts`:

```ts
export * from "./client.ts";
```

- [ ] **Step 5: Run tests**

```bash
cd workspace/void-os/protocol && bun test
```

Expected: 7 new client tests pass, plus existing schema + agents tests still pass.

- [ ] **Step 6: Commit**

```bash
cd workspace/void-os
git add protocol/src/client.ts protocol/src/index.ts protocol/test/client.test.ts
git commit -m "feat(VOS-117): protocol HTTP client + typed errors"
```

---

## Task 3: `cli/lib/args.ts` — argv parser

**Files:**
- Create: `workspace/void-os/cli/lib/args.ts`
- Create: `workspace/void-os/cli/lib/args.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/lib/args.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseArgs } from "./args.ts";

test("collects positionals and flags", () => {
  const r = parseArgs(["read", "notes.md", "--json"], { flags: ["json"], values: [] });
  expect(r.positional).toEqual(["read", "notes.md"]);
  expect(r.flags.json).toBe(true);
});

test("--key value form", () => {
  const r = parseArgs(["--port", "8080"], { flags: [], values: ["port"] });
  expect(r.values.port).toBe("8080");
});

test("--key=value form", () => {
  const r = parseArgs(["--port=8080"], { flags: [], values: ["port"] });
  expect(r.values.port).toBe("8080");
});

test("short bool flag -f", () => {
  const r = parseArgs(["-f"], { flags: ["follow"], values: [], shortMap: { f: "follow" } });
  expect(r.flags.follow).toBe(true);
});

test("--help is always parsed", () => {
  const r = parseArgs(["--help"], { flags: [], values: [] });
  expect(r.help).toBe(true);
});

test("missing value for --key throws", () => {
  expect(() => parseArgs(["--port"], { flags: [], values: ["port"] })).toThrow(/--port expects a value/);
});

test("unknown flag throws", () => {
  expect(() => parseArgs(["--weird"], { flags: [], values: [] })).toThrow(/unknown flag.*--weird/);
});

test("-- ends flag parsing", () => {
  const r = parseArgs(["--json", "--", "--not-a-flag"], { flags: ["json"], values: [] });
  expect(r.flags.json).toBe(true);
  expect(r.positional).toEqual(["--not-a-flag"]);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd workspace/void-os && bun test cli/lib/args.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `workspace/void-os/cli/lib/args.ts`:

```ts
export interface ParseSpec {
  flags: string[];                // boolean flags (e.g. ["json", "force"])
  values: string[];               // string-valued flags (e.g. ["port", "vault"])
  shortMap?: Record<string, string>; // e.g. { f: "follow", h: "help" }
}

export interface ParseResult {
  positional: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
  help: boolean;
}

export function parseArgs(argv: string[], spec: ParseSpec): ParseResult {
  const result: ParseResult = {
    positional: [],
    flags: {},
    values: {},
    help: false,
  };
  const flagSet = new Set(spec.flags);
  const valSet = new Set(spec.values);
  const shortMap = spec.shortMap ?? {};

  let i = 0;
  let stopFlags = false;
  while (i < argv.length) {
    const a = argv[i];
    if (stopFlags) {
      result.positional.push(a);
      i++;
      continue;
    }
    if (a === "--") {
      stopFlags = true;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      result.help = true;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (flagSet.has(key)) {
        result.flags[key] = true;
        i++;
        continue;
      }
      if (valSet.has(key)) {
        if (eq >= 0) {
          result.values[key] = a.slice(eq + 1);
          i++;
          continue;
        }
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`--${key} expects a value`);
        result.values[key] = v;
        i += 2;
        continue;
      }
      throw new Error(`unknown flag: --${key}`);
    }
    if (a.startsWith("-") && a.length === 2) {
      const long = shortMap[a[1]];
      if (long && flagSet.has(long)) {
        result.flags[long] = true;
        i++;
        continue;
      }
      throw new Error(`unknown flag: ${a}`);
    }
    result.positional.push(a);
    i++;
  }
  return result;
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/lib/args.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/lib/args.ts cli/lib/args.test.ts
git commit -m "feat(VOS-117): cli/lib/args.ts — argv parser"
```

---

## Task 4: `cli/lib/output.ts`

**Files:**
- Create: `workspace/void-os/cli/lib/output.ts`
- Create: `workspace/void-os/cli/lib/output.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/lib/output.test.ts`:

```ts
import { test, expect } from "bun:test";
import { renderTable, truncate, formatJson } from "./output.ts";

test("truncate adds ellipsis past max", () => {
  expect(truncate("hello world", 5)).toBe("hell…");
});

test("truncate leaves short strings", () => {
  expect(truncate("ok", 10)).toBe("ok");
});

test("renderTable lines up two columns", () => {
  const out = renderTable(
    [{ name: "maya", description: "default" }, { name: "scribe", description: "writer" }],
    [{ key: "name", width: 8 }, { key: "description", width: 20 }],
  );
  const lines = out.split("\n");
  expect(lines[0].startsWith("maya")).toBe(true);
  expect(lines[1].startsWith("scribe")).toBe(true);
  expect(lines[0].includes("default")).toBe(true);
});

test("renderTable truncates long descriptions", () => {
  const out = renderTable(
    [{ name: "a", description: "x".repeat(100) }],
    [{ key: "name", width: 4 }, { key: "description", width: 10 }],
  );
  expect(out.includes("…")).toBe(true);
});

test("formatJson is stable + indented", () => {
  expect(formatJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd workspace/void-os && bun test cli/lib/output.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `workspace/void-os/cli/lib/output.ts`:

```ts
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…".slice(0, max);
  return s.slice(0, max - 1) + "…";
}

export interface Column {
  key: string;
  width: number;
}

export function renderTable(rows: Array<Record<string, unknown>>, cols: Column[]): string {
  return rows
    .map((row) =>
      cols
        .map((c) => truncate(String(row[c.key] ?? ""), c.width).padEnd(c.width))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/lib/output.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/lib/output.ts cli/lib/output.test.ts
git commit -m "feat(VOS-117): cli/lib/output.ts — table + JSON helpers"
```

---

## Task 5: `cli/lib/state-dir.ts`

**Files:**
- Create: `workspace/void-os/cli/lib/state-dir.ts`
- Create: `workspace/void-os/cli/lib/state-dir.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/lib/state-dir.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir, tokenPath, pidPath, portPath, logPath, ensureStateDir } from "./state-dir.ts";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-state-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("stateDir respects current HOME (not cached)", () => {
  // Bun's os.homedir() caches at startup — the lib must use process.env.HOME.
  expect(stateDir()).toBe(join(tmp, ".void-os"));
});

test("path helpers point under stateDir", () => {
  expect(tokenPath()).toBe(join(tmp, ".void-os", "token"));
  expect(pidPath()).toBe(join(tmp, ".void-os", "daemon.pid"));
  expect(portPath()).toBe(join(tmp, ".void-os", "daemon.port"));
  expect(logPath()).toBe(join(tmp, ".void-os", "daemon.log"));
});

test("ensureStateDir creates dir if missing", () => {
  const dir = ensureStateDir();
  expect(dir).toBe(join(tmp, ".void-os"));
  // Re-call must be idempotent.
  ensureStateDir();
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd workspace/void-os && bun test cli/lib/state-dir.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `workspace/void-os/cli/lib/state-dir.ts`:

```ts
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync } from "node:fs";

// VOS-116 lesson: Bun caches os.homedir() at startup; tests swap HOME per-case.
function home(): string {
  return process.env.HOME ?? os.homedir();
}

export function stateDir(): string {
  return path.join(home(), ".void-os");
}

export function tokenPath(): string { return path.join(stateDir(), "token"); }
export function pidPath(): string { return path.join(stateDir(), "daemon.pid"); }
export function portPath(): string { return path.join(stateDir(), "daemon.port"); }
export function logPath(): string { return path.join(stateDir(), "daemon.log"); }

export function ensureStateDir(): string {
  const d = stateDir();
  mkdirSync(d, { recursive: true });
  return d;
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/lib/state-dir.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/lib/state-dir.ts cli/lib/state-dir.test.ts
git commit -m "feat(VOS-117): cli/lib/state-dir.ts — ~/.void-os path helpers"
```

---

## Task 6: `cli/lib/client.ts` — wire protocol client to state-dir

**Files:**
- Create: `workspace/void-os/cli/lib/client.ts`

- [ ] **Step 1: Implement**

(No dedicated test file — covered through cli/daemon, cli/agents, cli/vault integration tests in T8+.)

Create `workspace/void-os/cli/lib/client.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { makeClient, type Client, UnreachableError } from "@voidos/protocol";
import { tokenPath, portPath } from "./state-dir.ts";

export class NoTokenError extends Error {
  readonly name = "NoTokenError" as const;
  constructor() {
    super("no daemon token at ~/.void-os/token; run `void-os daemon start`");
  }
}

export function resolveBase(): string {
  if (process.env.VOID_OS_BASE) return process.env.VOID_OS_BASE;
  const pp = portPath();
  if (existsSync(pp)) {
    const port = readFileSync(pp, "utf8").trim();
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  }
  return "http://127.0.0.1:7777";
}

export function resolveToken(): string {
  if (process.env.VOID_OS_TOKEN) return process.env.VOID_OS_TOKEN;
  const tp = tokenPath();
  if (!existsSync(tp)) throw new NoTokenError();
  return readFileSync(tp, "utf8").trim();
}

export function buildClient(): Client {
  return makeClient({ base: resolveBase(), token: resolveToken() });
}

export { UnreachableError };
```

- [ ] **Step 2: Typecheck**

```bash
cd workspace/void-os && bunx tsc --noEmit -p protocol/tsconfig.json
```

Expected: clean (or the same pre-existing errors as before).

- [ ] **Step 3: Commit**

```bash
cd workspace/void-os
git add cli/lib/client.ts
git commit -m "feat(VOS-117): cli/lib/client.ts — buildClient + NoTokenError + base/token resolution"
```

---

## Task 7: `bin/void-os` dispatcher rewrite + top-level `--help`

**Files:**
- Modify: `workspace/void-os/bin/void-os`

- [ ] **Step 1: Inspect current dispatcher**

```bash
cat workspace/void-os/bin/void-os
```

Note: current passes `args.slice(1)` (handler doesn't see its own subcommand). New dispatcher passes full `args` so handlers can subdispatch.

- [ ] **Step 2: Rewrite**

Replace `workspace/void-os/bin/void-os` with:

```ts
#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMANDS = ["init", "daemon", "agents", "vault", "plugin"];

const TOP_USAGE = `usage: void-os <command> [args]

commands:
  init      provision a vault from starter-vault
  daemon    daemon lifecycle: start | stop | status | logs
  agents    introspect agents: list
  vault     vault ops: read | write | list
  plugin    Obsidian plugin: install | status

global flags:
  --help, -h    show usage for a command

environment:
  VOID_OS_BASE        override daemon URL (default http://127.0.0.1:<daemon.port> or :7777)
  VOID_OS_TOKEN       override auth token (default ~/.void-os/token)
  VOID_OS_PREFIX      override repo prefix (default: dir of this binary's parent)
  VOID_OS_PORT        default port for \`daemon start\` (default 7777)
  VOID_OS_VAULT_ROOT  default vault for \`daemon start\`

exit codes: 0 ok · 1 runtime · 2 usage · 3 daemon unreachable
`;

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  console.log(TOP_USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

const cmd = argv[0];
const rest = argv.slice(1);

if (!COMMANDS.includes(cmd)) {
  console.error(`void-os: unknown command "${cmd}"`);
  console.error(TOP_USAGE);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const prefix = process.env.VOID_OS_PREFIX ?? resolve(here, "..");
const handler = resolve(prefix, "cli", `${cmd}.ts`);

if (!existsSync(handler)) {
  console.error(`void-os: handler not found: ${handler}`);
  process.exit(1);
}

const mod = await import(handler);
const code = await mod.default(rest, { prefix });
process.exit(typeof code === "number" ? code : 0);
```

- [ ] **Step 3: Existing `cli/init.ts` and `cli/daemon.ts` must still accept the new signature**

`cli/init.ts` already takes `(args, ctx)` and returns void (exit 0). No change.
`cli/daemon.ts` will be rewritten in T8. The old daemon handler will be replaced — no need to patch its signature now.

- [ ] **Step 4: Smoke**

```bash
cd workspace/void-os && ./bin/void-os --help
```

Expected: usage block printed, exit 0.

```bash
cd workspace/void-os && ./bin/void-os; echo exit=$?
```

Expected: usage block, exit 2.

```bash
cd workspace/void-os && ./bin/void-os bogus 2>&1; echo exit=$?
```

Expected: "unknown command" + usage, exit 2.

- [ ] **Step 5: Run existing init test (no regression)**

```bash
cd workspace/void-os && bun test cli/init.test.ts
```

Expected: still green.

- [ ] **Step 6: Commit**

```bash
cd workspace/void-os
git add bin/void-os
git commit -m "feat(VOS-117): bin/void-os — top-level dispatcher with --help + exit codes"
```

---

## Task 8: `daemon start` (with /health poll race + early child-exit)

**Files:**
- Modify: `workspace/void-os/cli/daemon.ts`
- Create: `workspace/void-os/cli/daemon.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `workspace/void-os/cli/daemon.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let origPort: string | undefined;
let port: number;

function pickPort(): number {
  // Avoid collision with default 7777 + other tests by drawing from 18000-18999.
  return 18000 + Math.floor(Math.random() * 1000);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-daemon-"));
  origHome = process.env.HOME;
  origPort = process.env.VOID_OS_PORT;
  process.env.HOME = tmp;
  port = pickPort();
});

afterEach(() => {
  // Best-effort kill any leftover daemon for this HOME.
  const pidFile = join(tmp, ".void-os/daemon.pid");
  if (existsSync(pidFile)) {
    try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL"); } catch {}
  }
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origPort !== undefined) process.env.VOID_OS_PORT = origPort; else delete process.env.VOID_OS_PORT;
  rmSync(tmp, { recursive: true, force: true });
});

test("start writes pid + port and /health returns ready", async () => {
  const vault = join(tmp, "vault");
  // intentionally do NOT mkdir vault — start must create it.
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], {
    env: { ...process.env, HOME: tmp },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("void-os daemon ready");
  expect(existsSync(join(tmp, ".void-os/daemon.pid"))).toBe(true);
  expect(readFileSync(join(tmp, ".void-os/daemon.port"), "utf8").trim()).toBe(String(port));
  expect(existsSync(vault)).toBe(true);
});

test("second start prints already running", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("already running");
});

test("start with port already in use exits 1 quickly (child-exit race)", async () => {
  const vault = join(tmp, "vault");
  // First start succeeds.
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  // Move pid file aside so the second start doesn't see "already running" and tries to spawn.
  const pidFile = join(tmp, ".void-os/daemon.pid");
  const stashed = pidFile + ".stash";
  Bun.spawnSync(["mv", pidFile, stashed]);
  const t0 = Date.now();
  const r = spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 15000 });
  const elapsed = Date.now() - t0;
  // The failed second start cleans up its own pid file on the child-exit path,
  // but be defensive: if anything was written, kill that PID before restoring
  // the stashed pid file — otherwise afterEach would SIGKILL the wrong process.
  if (existsSync(pidFile)) {
    try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL"); } catch {}
    rmSync(pidFile, { force: true });
  }
  Bun.spawnSync(["mv", stashed, pidFile]);
  expect(r.status).not.toBe(0);
  // Should bail early (< 5 s), not wait the full 10 s poll timeout.
  expect(elapsed).toBeLessThan(7000);
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: FAIL — current `cli/daemon.ts` doesn't implement `start`.

- [ ] **Step 3: Implement `cli/daemon.ts` (start only for now)**

Replace `workspace/void-os/cli/daemon.ts` with:

```ts
import { spawn } from "node:child_process";
import { openSync, writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { ensureStateDir, pidPath, portPath, logPath, tokenPath } from "./lib/state-dir.ts";
import { formatJson, renderTable } from "./lib/output.ts";

const DAEMON_USAGE = `usage: void-os daemon <subcommand>

subcommands:
  start [--port N] [--vault PATH]   start the daemon (detached, blocks until /health 200, 10s timeout)
  stop                              SIGTERM then SIGKILL the daemon
  status [--json]                   running/stopped + health info
  logs [-f|--follow] [--tail N]     print or tail ~/.void-os/daemon.log
`;

export default async function daemon(args: string[], ctx: { prefix: string }): Promise<number> {
  // args[0] is "daemon" (full argv from new dispatcher).
  // Dispatcher passes argv.slice(1) to handler (e.g. ["start", "--port", "8080"] for `void-os daemon start --port 8080`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(DAEMON_USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "start":  return cmdStart(rest, ctx);
    case "stop":   return cmdStop(rest);
    case "status": return cmdStatus(rest);
    case "logs":   return cmdLogs(rest);
    default:
      console.error(`void-os daemon: unknown subcommand "${sub}"`);
      console.error(DAEMON_USAGE);
      return 2;
  }
}

async function cmdStart(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: [], values: ["port", "vault"] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }

  const port = Number(parsed.values.port ?? process.env.VOID_OS_PORT ?? "7777");
  const vault = parsed.values.vault ?? process.env.VOID_OS_VAULT_ROOT;

  ensureStateDir();
  // Already running?
  if (existsSync(pidPath())) {
    const oldPid = parseInt(readFileSync(pidPath(), "utf8"), 10);
    if (Number.isFinite(oldPid) && isAlive(oldPid)) {
      const oldPort = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "?";
      console.log(`already running (pid=${oldPid} port=${oldPort})`);
      return 0;
    }
  }

  // Resolve vault, mkdir it before spawn — daemon exits 2 if missing.
  const resolvedVault = vault ?? join(process.env.HOME ?? "", "Library/Application Support/void-os/vault");
  mkdirSync(resolvedVault, { recursive: true });

  // Open log file (append).
  const logFd = openSync(logPath(), "a");
  const entry = join(ctx.prefix, "daemon/src/index.ts");
  const child = spawn("bun", ["run", entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      VOID_OS_PORT: String(port),
      VOID_OS_VAULT_ROOT: resolvedVault,
    },
  });
  child.unref();

  if (!child.pid) {
    console.error(`spawn failed`);
    return 1;
  }
  writeFileSync(pidPath(), String(child.pid));
  writeFileSync(portPath(), String(port));

  const ready = await raceHealth(child, port, 10000);
  if (ready === "ok") {
    const h = ready_health!;
    console.log(`void-os daemon ready (pid=${child.pid} port=${port} vault=${resolvedVault} version=${h.version ?? "?"})`);
    return 0;
  }
  // Failure path: ensure child dead, clean files, print log tail.
  try { process.kill(child.pid, "SIGKILL"); } catch {}
  if (existsSync(pidPath())) unlinkSync(pidPath());
  if (existsSync(portPath())) unlinkSync(portPath());
  console.error(`void-os daemon failed to start (${ready})`);
  printLogTail(20);
  return 1;
}

// Tiny mutable carrier so cmdStart can read the parsed health body.
let ready_health: { version?: string } | null = null;

async function raceHealth(child: import("node:child_process").ChildProcess, port: number, timeoutMs: number): Promise<"ok" | "timeout" | "child-exit"> {
  ready_health = null;
  const start = Date.now();
  let childExited = false;
  child.once("exit", () => { childExited = true; });
  while (Date.now() - start < timeoutMs) {
    if (childExited) return "child-exit";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
      if (r.ok) {
        try { ready_health = await r.json() as { version?: string }; } catch { ready_health = {}; }
        return "ok";
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return "timeout";
}

function tokenOrEmpty(): string {
  try { return readFileSync(tokenPath(), "utf8").trim(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function printLogTail(n: number): void {
  try {
    const lp = logPath();
    if (!existsSync(lp)) return;
    const body = readFileSync(lp, "utf8");
    const lines = body.split("\n");
    console.error(lines.slice(-n).join("\n"));
  } catch {}
}

// Stubs — implemented in T9/T10/T11.
async function cmdStop(_args: string[]): Promise<number> { console.error("not yet implemented"); return 1; }
async function cmdStatus(_args: string[]): Promise<number> { console.error("not yet implemented"); return 1; }
async function cmdLogs(_args: string[]): Promise<number> { console.error("not yet implemented"); return 1; }
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 3/3 pass. (First two start tests take a few seconds each due to real daemon spawn.)

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/daemon.ts cli/daemon.test.ts
git commit -m "feat(VOS-117): cli daemon start — detached spawn + /health poll race"
```

---

## Task 9: `daemon stop` (with /health-verify before signal)

**Files:**
- Modify: `workspace/void-os/cli/daemon.ts`
- Modify: `workspace/void-os/cli/daemon.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `workspace/void-os/cli/daemon.test.ts`:

```ts
test("stop removes pid/port files and exits 0", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stopped");
  expect(existsSync(join(tmp, ".void-os/daemon.pid"))).toBe(false);
  expect(existsSync(join(tmp, ".void-os/daemon.port"))).toBe(false);
});

test("stop with no pid file is idempotent (not running, exit 0)", async () => {
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("not running");
});

test("stop with stale pid file (live PID, no daemon) treats as stale (exit 0, no signal)", async () => {
  // Plant pid of *this* test process (definitely alive but not a void-os daemon).
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  writeFileSync(join(tmp, ".void-os/daemon.pid"), String(process.pid));
  writeFileSync(join(tmp, ".void-os/daemon.port"), String(port));
  const r = spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("stale pid");
  // Test process must still be alive (test reaches this line).
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run, verify the new tests fail**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 3 new fail (stub returns 1).

- [ ] **Step 3: Implement `cmdStop`**

Replace the `cmdStop` stub in `cli/daemon.ts`:

```ts
async function cmdStop(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: [], values: [] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }

  if (!existsSync(pidPath())) {
    console.log("not running");
    return 0;
  }
  const pid = parseInt(readFileSync(pidPath(), "utf8"), 10);
  if (!Number.isFinite(pid) || !isAlive(pid)) {
    cleanupFiles();
    console.log("not running");
    return 0;
  }
  // Anti-PID-recycle: verify the live PID is actually void-os via /health.
  const port = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "";
  let identified = false;
  if (/^\d+$/.test(port)) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
      if (r.ok) {
        const body = await r.json() as { version?: string };
        if (body && typeof body.version === "string") identified = true;
      }
    } catch { /* unreachable — treat as stale */ }
  }
  if (!identified) {
    cleanupFiles();
    console.log("not running (stale pid file)");
    return 0;
  }
  // Signal.
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await sleep(100);
  }
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && isAlive(pid)) await sleep(50);
  }
  cleanupFiles();
  console.log("stopped");
  return 0;
}

function cleanupFiles(): void {
  if (existsSync(pidPath())) unlinkSync(pidPath());
  if (existsSync(portPath())) unlinkSync(portPath());
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/daemon.ts cli/daemon.test.ts
git commit -m "feat(VOS-117): cli daemon stop — /health-verify before signal (anti-PID-recycle)"
```

---

## Task 10: `daemon status`

**Files:**
- Modify: `workspace/void-os/cli/daemon.ts`
- Modify: `workspace/void-os/cli/daemon.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `workspace/void-os/cli/daemon.test.ts`:

```ts
test("status when stopped prints stopped, exit 0", async () => {
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("stopped");
});

test("status when stopped --json", async () => {
  const r = spawnSync(BIN, ["daemon", "status", "--json"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ running: false });
});

test("status when running prints pid/port/vault/version", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["daemon", "status"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`port: ${port}`);
  expect(r.stdout).toContain(`vault: ${vault}`);
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
});
```

- [ ] **Step 2: Run, verify they fail**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 3 new fail.

- [ ] **Step 3: Implement `cmdStatus`**

Replace stub:

```ts
async function cmdStatus(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }
  const asJson = !!parsed.flags.json;

  const pidExists = existsSync(pidPath());
  const pid = pidExists ? parseInt(readFileSync(pidPath(), "utf8"), 10) : NaN;
  const alive = Number.isFinite(pid) && isAlive(pid);
  if (!alive) {
    if (asJson) console.log(formatJson({ running: false }));
    else console.log("stopped");
    return 0;
  }
  const portStr = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "";
  if (!/^\d+$/.test(portStr)) {
    if (asJson) console.log(formatJson({ running: true, pid, error: "no port file" }));
    else console.log(`running (pid=${pid}) but unhealthy: no port file`);
    return 1;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${portStr}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const h = await r.json() as { version?: string; vault_root?: string; uptime_s?: number; sessions?: number };
    if (asJson) {
      console.log(formatJson({ running: true, pid, port: Number(portStr), ...h }));
    } else {
      console.log(`running`);
      console.log(`  pid:        ${pid}`);
      console.log(`  port:       ${portStr}`);
      console.log(`  vault:      ${h.vault_root}`);
      console.log(`  uptime_s:   ${h.uptime_s}`);
      console.log(`  version:    ${h.version}`);
      console.log(`  sessions:   ${h.sessions}`);
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (asJson) console.log(formatJson({ running: true, pid, port: Number(portStr), error: msg }));
    else console.log(`running (pid=${pid}) but unhealthy: ${msg}`);
    return 1;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/daemon.ts cli/daemon.test.ts
git commit -m "feat(VOS-117): cli daemon status — human + --json"
```

---

## Task 11: `daemon logs`

**Files:**
- Modify: `workspace/void-os/cli/daemon.ts`
- Modify: `workspace/void-os/cli/daemon.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test("logs --tail prints last N lines from log file", () => {
  mkdirSync(join(tmp, ".void-os"), { recursive: true });
  const lp = join(tmp, ".void-os/daemon.log");
  writeFileSync(lp, "L1\nL2\nL3\nL4\nL5\nL6\n");
  const r = spawnSync(BIN, ["daemon", "logs", "--tail", "3"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines.slice(-3)).toEqual(["L4", "L5", "L6"]);
});

test("logs without file prints message + exit 0", () => {
  const r = spawnSync(BIN, ["daemon", "logs"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("no daemon log yet");
});
```

- [ ] **Step 2: Run, verify they fail**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

- [ ] **Step 3: Implement `cmdLogs`**

```ts
async function cmdLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["follow"], values: ["tail"], shortMap: { f: "follow" } });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }
  const lp = logPath();
  if (!existsSync(lp)) {
    console.error("no daemon log yet");
    return 0;
  }
  if (parsed.flags.follow) {
    // tail -f, inherit stdio so Ctrl-C reaches tail directly.
    const child = spawn("tail", ["-f", lp], { stdio: "inherit" });
    return await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
  }
  const n = Math.max(0, parseInt(parsed.values.tail ?? "200", 10));
  const body = readFileSync(lp, "utf8");
  const lines = body.split("\n");
  process.stdout.write(lines.slice(-n).join("\n"));
  if (!body.endsWith("\n")) process.stdout.write("\n");
  return 0;
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/daemon.test.ts
```

Expected: 11/11 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/daemon.ts cli/daemon.test.ts
git commit -m "feat(VOS-117): cli daemon logs — tail N + --follow"
```

---

## Task 12: `agents list`

**Files:**
- Create: `workspace/void-os/cli/agents.ts`
- Create: `workspace/void-os/cli/agents.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/agents.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let port: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-agents-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  port = 18000 + Math.floor(Math.random() * 1000);
});

afterEach(() => {
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("agents list against running daemon (--json)", async () => {
  const vault = join(tmp, "vault");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["agents", "list", "--json"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(Array.isArray(body.agents)).toBe(true);
});

test("agents list against no daemon exits 3", () => {
  const r = spawnSync(BIN, ["agents", "list"], { env: { ...process.env, HOME: tmp, VOID_OS_BASE: `http://127.0.0.1:${port}`, VOID_OS_TOKEN: "x" }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(3);
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd workspace/void-os && bun test cli/agents.test.ts
```

Expected: FAIL — agents.ts missing.

- [ ] **Step 3: Implement**

Create `workspace/void-os/cli/agents.ts`:

```ts
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { UnreachableError } from "@voidos/protocol";
import { renderTable, formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os agents <subcommand>

subcommands:
  list [--json]   list agents from current vault
`;

export default async function agents(args: string[]): Promise<number> {
  // Dispatcher passes argv.slice(1) to handler (e.g. ["start", "--port", "8080"] for `void-os daemon start --port 8080`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  if (sub === "list") return cmdList(rest);
  console.error(`void-os agents: unknown subcommand "${sub}"`);
  console.error(USAGE);
  return 2;
}

async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(USAGE); return 0; }
  try {
    const client = buildClient();
    const r = await client.agents.list();
    if (parsed.flags.json) console.log(formatJson(r));
    else {
      if (r.agents.length === 0) console.log("(no agents)");
      else console.log(renderTable(r.agents, [{ key: "name", width: 20 }, { key: "description", width: 58 }]));
    }
    return 0;
  } catch (e) {
    if (e instanceof UnreachableError || e instanceof NoTokenError) {
      console.error(`daemon not running; try \`void-os daemon start\``);
      return 3;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/agents.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/agents.ts cli/agents.test.ts
git commit -m "feat(VOS-117): cli agents list — human table + --json"
```

---

## Task 13: `vault read` (with byte-exact cat semantics)

**Files:**
- Create: `workspace/void-os/cli/vault.ts`
- Create: `workspace/void-os/cli/vault.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/vault.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let origHome: string | undefined;
let port: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-vault-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  port = 18000 + Math.floor(Math.random() * 1000);
});

afterEach(() => {
  spawnSync(BIN, ["daemon", "stop"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("vault read writes content byte-exact (with trailing newline)", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "notes.md"), "hello\n");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "read", "notes.md"], { env: { ...process.env, HOME: tmp }, encoding: "buffer", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout.toString("utf8")).toBe("hello\n");
});

test("vault read byte-exact (no trailing newline)", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "raw.txt"), "hi");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "read", "raw.txt"], { env: { ...process.env, HOME: tmp }, encoding: "buffer", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout.toString("utf8")).toBe("hi");
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

- [ ] **Step 3: Implement (read only for now)**

Create `workspace/void-os/cli/vault.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { ApiError, UnreachableError } from "@voidos/protocol";
import { formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os vault <subcommand>

subcommands:
  read <path> [--json]
  write <path> {--content STR | --from-file LOCAL | --stdin}
  list [<path>] [--depth N] [--json]
`;

export default async function vault(args: string[]): Promise<number> {
  // Dispatcher passes argv.slice(1) to handler (e.g. ["start", "--port", "8080"] for `void-os daemon start --port 8080`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "read":  return cmdRead(rest);
    case "write": return cmdWrite(rest);
    case "list":  return cmdList(rest);
    default:
      console.error(`void-os vault: unknown subcommand "${sub}"`);
      console.error(USAGE);
      return 2;
  }
}

async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const path = parsed.positional[0];
  if (!path) { console.error("usage: void-os vault read <path>"); return 2; }
  try {
    const client = buildClient();
    const r = await client.vault.read(path);
    if (parsed.flags.json) console.log(formatJson(r));
    else process.stdout.write(r.content);   // byte-exact, no added newline
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

async function cmdWrite(_args: string[]): Promise<number> { console.error("not yet implemented"); return 1; }
async function cmdList(_args: string[]): Promise<number> { console.error("not yet implemented"); return 1; }

function handleError(e: unknown): number {
  if (e instanceof UnreachableError || e instanceof NoTokenError) {
    console.error(`daemon not running; try \`void-os daemon start\``);
    return 3;
  }
  if (e instanceof ApiError) {
    if (e.code === "E_BINARY") { console.error("binary file, use --json"); return 1; }
    console.error(`${e.code}: ${e.message}`);
    return 1;
  }
  console.error(e instanceof Error ? e.message : String(e));
  return 1;
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/vault.ts cli/vault.test.ts
git commit -m "feat(VOS-117): cli vault read — cat-semantics + --json"
```

---

## Task 14: `vault write`

**Files:**
- Modify: `workspace/void-os/cli/vault.ts`
- Modify: `workspace/void-os/cli/vault.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test("vault write --content writes file", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "out.md", "--content", "world"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("wrote out.md");
  expect(readFileSync(join(vault, "out.md"), "utf8")).toBe("world");
});

test("vault write rejects multiple sources", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "x.md", "--content", "a", "--stdin"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("exactly one source");
});

test("vault write rejects zero sources", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "write", "x.md"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("exactly one source");
});
```

- [ ] **Step 2: Run, verify they fail**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

- [ ] **Step 3: Replace `cmdWrite` stub**

```ts
async function cmdWrite(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["stdin", "json"], values: ["content", "from-file"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const path = parsed.positional[0];
  if (!path) { console.error("usage: void-os vault write <path> {--content STR | --from-file LOCAL | --stdin}"); return 2; }

  const sources: Array<{ kind: string; value: string | true }> = [];
  if (parsed.values["content"] !== undefined) sources.push({ kind: "content", value: parsed.values["content"] });
  if (parsed.values["from-file"] !== undefined) sources.push({ kind: "from-file", value: parsed.values["from-file"] });
  if (parsed.flags.stdin) sources.push({ kind: "stdin", value: true });
  if (sources.length !== 1) {
    console.error("usage: vault write requires exactly one source: --content, --from-file, or --stdin");
    return 2;
  }

  let body: string;
  const src = sources[0];
  if (src.kind === "content") body = src.value as string;
  else if (src.kind === "from-file") body = readFileSync(src.value as string, "utf8");
  else body = await readStdin();

  try {
    const client = buildClient();
    const r = await client.vault.write(path, body);
    if (parsed.flags.json) console.log(formatJson(r));
    else console.log(`wrote ${path} (${r.size} bytes)`);
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/vault.ts cli/vault.test.ts
git commit -m "feat(VOS-117): cli vault write — content|from-file|stdin"
```

---

## Task 15: `vault list`

**Files:**
- Modify: `workspace/void-os/cli/vault.ts`
- Modify: `workspace/void-os/cli/vault.test.ts`

- [ ] **Step 1: Append failing test**

```ts
test("vault list prints one path per line", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "a");
  writeFileSync(join(vault, "b.md"), "b");
  spawnSync(BIN, ["daemon", "start", "--port", String(port), "--vault", vault], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 30000 });
  const r = spawnSync(BIN, ["vault", "list"], { env: { ...process.env, HOME: tmp }, encoding: "utf8", timeout: 10000 });
  expect(r.status).toBe(0);
  // Daemon vault/list returns entries with path field; CLI prints one per line.
  expect(r.stdout).toContain("a.md");
  expect(r.stdout).toContain("b.md");
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

- [ ] **Step 3: Replace `cmdList` stub**

```ts
async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["depth"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const subpath = parsed.positional[0];
  const depth = parsed.values.depth != null ? parseInt(parsed.values.depth, 10) : undefined;
  try {
    const client = buildClient();
    const r = await client.vault.list(subpath, depth != null ? { depth } : undefined);
    if (parsed.flags.json) console.log(formatJson(r));
    else for (const e of r.entries) console.log(e.type === "dir" ? `${e.name}/` : e.name);
    return 0;
  } catch (e) {
    return handleError(e);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/vault.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/vault.ts cli/vault.test.ts
git commit -m "feat(VOS-117): cli vault list — paths or --json"
```

---

## Task 16: `plugin install`

**Files:**
- Create: `workspace/void-os/cli/plugin.ts`
- Create: `workspace/void-os/cli/plugin.test.ts`

- [ ] **Step 1: Write failing test**

Create `workspace/void-os/cli/plugin.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VOS_ROOT = resolve(__dirname, "..");
const BIN = join(VOS_ROOT, "bin/void-os");

let tmp: string;
let prefix: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vos117-plugin-"));
  prefix = join(tmp, "prefix");
  // Mirror enough of the void-os layout so the dispatcher loads cli/plugin.ts from prefix.
  mkdirSync(join(prefix, "cli"), { recursive: true });
  mkdirSync(join(prefix, "plugin/dist"), { recursive: true });
  // Symlink cli/ contents from real workspace so we don't duplicate code.
  const realCli = resolve(__dirname);
  for (const f of ["plugin.ts", "lib"]) {
    Bun.spawnSync(["ln", "-sf", join(realCli, f), join(prefix, "cli", f)]);
  }
  writeFileSync(join(prefix, "plugin/dist/manifest.json"), JSON.stringify({ id: "void-os", version: "0.1.0" }));
  writeFileSync(join(prefix, "plugin/dist/main.js"), "// build artifact");
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

test("plugin install --vault copies dist tree, exits 0", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("installed plugin");
  const target = join(vault, ".obsidian/plugins/void-os/manifest.json");
  expect(existsSync(target)).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8")).version).toBe("0.1.0");
});

test("plugin install idempotent: second run is up-to-date", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("up-to-date");
});

test("plugin install --force overwrites", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault, "--force"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("installed plugin");
});

test("plugin install without --vault and daemon down exits 3", () => {
  const r = spawnSync(BIN, ["plugin", "install"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(3);
});

test("plugin install with missing dist exits 1", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  rmSync(join(prefix, "plugin/dist"), { recursive: true, force: true });
  const r = spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("plugin not built");
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd workspace/void-os && bun test cli/plugin.test.ts
```

- [ ] **Step 3: Implement (install only for now)**

Create `workspace/void-os/cli/plugin.ts`:

```ts
import { cpSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { UnreachableError } from "@voidos/protocol";
import { formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os plugin <subcommand>

subcommands:
  install [--vault PATH] [--force]
  status  [--vault PATH] [--json]
`;

export default async function plugin(args: string[], ctx: { prefix: string }): Promise<number> {
  // Dispatcher passes argv.slice(1) to handler (e.g. ["start", "--port", "8080"] for `void-os daemon start --port 8080`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "install": return cmdInstall(rest, ctx);
    case "status":  return cmdStatus(rest, ctx);
    default:
      console.error(`void-os plugin: unknown subcommand "${sub}"`);
      console.error(USAGE);
      return 2;
  }
}

async function resolveVault(args: { vault?: string }): Promise<string | { code: number }> {
  if (args.vault) return args.vault;
  try {
    const client = buildClient();
    const h = await client.health();
    return h.vault_root;
  } catch (e) {
    if (e instanceof UnreachableError || e instanceof NoTokenError) {
      console.error(`no --vault and daemon not running; try \`void-os daemon start\` or pass --vault PATH`);
      return { code: 3 };
    }
    console.error(e instanceof Error ? e.message : String(e));
    return { code: 1 };
  }
}

async function cmdInstall(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: ["force"], values: ["vault"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const resolved = await resolveVault({ vault: parsed.values.vault });
  if (typeof resolved !== "string") return resolved.code;
  const vault = resolved;

  const src = join(ctx.prefix, "plugin/dist");
  if (!existsSync(src)) {
    console.error("plugin not built; run `bun run build` in plugin/");
    return 1;
  }
  const target = join(vault, ".obsidian/plugins/void-os");
  const srcManifest = readManifest(join(src, "manifest.json"));
  const tgtManifest = existsSync(join(target, "manifest.json")) ? readManifest(join(target, "manifest.json")) : null;

  if (!parsed.flags.force && tgtManifest && tgtManifest.version === srcManifest?.version) {
    console.log(`up-to-date (version ${srcManifest.version})`);
    return 0;
  }

  mkdirSync(target, { recursive: true });
  cpSync(src, target, { recursive: true, force: true });
  console.log(`installed plugin to ${target} (version ${srcManifest?.version ?? "?"})`);
  return 0;
}

async function cmdStatus(_args: string[], _ctx: { prefix: string }): Promise<number> {
  console.error("not yet implemented");
  return 1;
}

function readManifest(path: string): { version?: string; id?: string } | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/plugin.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/plugin.ts cli/plugin.test.ts
git commit -m "feat(VOS-117): cli plugin install — vault resolve + idempotent copy"
```

---

## Task 17: `plugin status`

**Files:**
- Modify: `workspace/void-os/cli/plugin.ts`
- Modify: `workspace/void-os/cli/plugin.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test("plugin status missing target", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault, "--json"], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(body.status).toBe("missing");
});

test("plugin status up-to-date after install", () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  spawnSync(BIN, ["plugin", "install", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("up-to-date");
});

test("plugin status upgrade-available when target older", () => {
  const vault = join(tmp, "vault");
  const target = join(vault, ".obsidian/plugins/void-os");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ id: "void-os", version: "0.0.1" }));
  const r = spawnSync(BIN, ["plugin", "status", "--vault", vault], { env: { ...process.env, HOME: tmp, VOID_OS_PREFIX: prefix }, encoding: "utf8", timeout: 5000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("upgrade-available");
});
```

- [ ] **Step 2: Run, verify they fail**

```bash
cd workspace/void-os && bun test cli/plugin.test.ts
```

- [ ] **Step 3: Replace `cmdStatus` stub**

```ts
async function cmdStatus(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["vault"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const resolved = await resolveVault({ vault: parsed.values.vault });
  if (typeof resolved !== "string") return resolved.code;
  const vault = resolved;

  const src = join(ctx.prefix, "plugin/dist");
  const target = join(vault, ".obsidian/plugins/void-os");
  const sm = existsSync(join(src, "manifest.json")) ? readManifest(join(src, "manifest.json")) : null;
  const tm = existsSync(join(target, "manifest.json")) ? readManifest(join(target, "manifest.json")) : null;

  let status: "missing" | "up-to-date" | "upgrade-available" | "ahead";
  if (!tm) status = "missing";
  else if (!sm || sm.version === tm.version) status = "up-to-date";
  else if ((tm.version ?? "") < (sm.version ?? "")) status = "upgrade-available";
  else status = "ahead";

  if (parsed.flags.json) {
    console.log(formatJson({ installed: tm?.version ?? null, source: sm?.version ?? null, target_path: target, status }));
  } else {
    console.log(`installed: ${tm?.version ?? "(none)"}  source: ${sm?.version ?? "(none)"}  status: ${status}`);
  }
  return 0;
}
```

- [ ] **Step 4: Run tests**

```bash
cd workspace/void-os && bun test cli/plugin.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
cd workspace/void-os
git add cli/plugin.ts cli/plugin.test.ts
git commit -m "feat(VOS-117): cli plugin status — version compare"
```

---

## Task 18: `docs/api.md` update + regression sweep + smoke

**Files:**
- Modify: `workspace/void-os/docs/api.md`

- [ ] **Step 1: Inspect `docs/api.md`**

```bash
wc -l workspace/void-os/docs/api.md
```

- [ ] **Step 2: Append CLI section**

Append to `workspace/void-os/docs/api.md`:

```markdown
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
```

- [ ] **Step 3: Run full test suite**

```bash
cd workspace/void-os && bun test
```

Expected: all new tests pass + no regressions in daemon/plugin/init suites. Pre-existing failures (migration-0007, probeClaudev, matchPath fuzz) acceptable per VOS-116 baseline.

- [ ] **Step 4: Typecheck**

```bash
cd workspace/void-os && bunx tsc --noEmit -p protocol/tsconfig.json
```

Expected: clean.

- [ ] **Step 5: Manual smoke (against `bun link`-installed binary)**

```bash
cd workspace/void-os && bun link
cd /tmp
void-os --help
void-os daemon start
void-os daemon status
void-os agents list
void-os vault list
void-os plugin status --vault "$HOME/Library/Application Support/void-os/vault"
void-os daemon logs --tail 5
void-os daemon stop
echo "smoke OK"
bun unlink || true
```

Each command exits 0 (agents/vault may return empty lists on fresh install — still exit 0).

- [ ] **Step 6: Commit**

```bash
cd workspace/void-os
git add docs/api.md
git commit -m "docs(VOS-117): api.md — CLI state files, env overrides, exit codes"
```

- [ ] **Step 7: Run requesting-code-review**

After T18 commit, dispatch `superpowers:requesting-code-review` over the full branch to gate /done.

---

## Self-review checklist

- Spec coverage: all 13 acceptance bullets in the task have a T-task: bin/bun-link (T0/T7), daemon start (T8) / stop (T9) / status (T10) / logs (T11), agents list (T12), vault read/write/list (T13/T14/T15), plugin install/status (T16/T17), --help + exit codes (T7), protocol/ usage (T1/T2/T6).
- Spec sections "Risks" + "Decisions" referenced but not encoded as tasks — they don't need code, only awareness; subagents inherit via the spec link in T0.
- Placeholder scan: no "TBD"/"TODO"/"similar to" anywhere; every code step has the actual code.
- Type consistency: `Client` interface in T2 matches usage in T6/T12/T13/T14/T15. `ApiError`/`UnreachableError` thrown in T2, caught in T12/T13. `parseArgs` shape (`flags`, `values`, `positional`, `help`) consistent across T3/T8/T9/T10/T11/T12/T13/T14/T15/T16/T17. `NoTokenError` introduced in T6, caught in T12/T13/T16.
- Forge fixes encoded: vault mkdir before spawn (T8 step 3), child-exit race (T8 step 3 + T8 test 3), /health verify in stop (T9 step 3 + T9 test 3), bun-link spike (T0), vault read byte-exact tests (T13 tests 1+2).
