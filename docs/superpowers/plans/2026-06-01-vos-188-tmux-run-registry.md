# VOS-188 — tmux Run substrate + hooks→SQLite registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout: every code task writes a failing test first.

**Goal:** Refactor the void-os daemon spawn path from headless `vc -p` (fire-and-forget, filesystem-derived status) to **interactive CC inside a named tmux session (a Run)**, tracked by a **hooks→SQLite registry** (`runs` + `sessions` tables), with a CC-hook-driven run.state machine, kill-session stop, and an idle-reaper — preserving VOS-185 drain + VOS-187 stop behaviors through the new path.

**Architecture:** void-os = Bun + Hono daemon (`src/server.ts`/`src/serve.ts`) rendering HTML string templates. Today a launch is `spawnTurn` → `node:child_process.spawn` of `vc -- --session-id <uuid> -p /<skill>` (headless), with status derived purely from filesystem markers in `sessions/<uuid>/`. This plan adds a **Run substrate**: every Run is `tmux new-session -d -s vos-run-<run-id>` running interactive `vc`/`claude`, recorded in a SQLite registry. CC lifecycle **hooks** (configured via a daemon-owned `settings.json`, delivered to the daemon over an **HTTP hook endpoint** keyed by CC's `session_id`) drive the `runs.state` machine. Stop = `tmux kill-session`. An idle-reaper sweeps stale idle Runs. The registry — NOT capture-pane — is the dashboard's state source.

**Tech Stack:** Bun 1.3.14 (`bun:sqlite` built-in — no new dep), Hono 4.6, tmux 3.6a (`/opt/homebrew/bin/tmux`), `vc` v0.2.2, CC hooks (HTTP type), TypeScript. `bun run verify` = `bash scripts/verify.sh` (`bunx tsc --noEmit && bun test`). Unit tests: `tests/*.test.ts`. E2E specs run standalone: `bun run tests/e2e-*.ts`.

---

## Load-bearing facts (verified against the repo + CC docs, 2026-06-01 — do NOT re-derive)

**Spawn path (current):**
- `src/spawn.ts:spawnTurn(vault, uuid, argv, command)` — fire-and-forget; `node:child_process.spawn(toks[0], [...toks.slice(1), ...argv], {cwd:vault, env:{...,VOID_OS_SESSION:uuid}, detached:true, stdio:["ignore",logFd,logFd]})`; persists `vc.pid`; exit handler writes `error.txt` on non-advance (race-guarded by `stopped.txt`). `runTurn(cwd, vault, uuid, argv, command)` — awaitable variant used by drains, runs in worktree cwd.
- `src/spawn.ts:buildLaunchArgv(uuid, skill, text)` → `["--session-id", uuid, "-p", prompt, "--permission-mode", "bypassPermissions"]`. `buildAnswerArgv(uuid, text)` → `["--resume", uuid, "-p", preamble+text, ...PERM]`.
- The `--session-id <uuid>` we mint **IS** the `session_id` CC emits in every hook payload (CC docs, common input fields). `--resume <uuid>` resumes that same id. This is the resume_token seam.
- `src/server.ts` POST `/launch` (lines 65–98): relay-auth guard → `mkdirSync(sessionDir)` → write `session-meta.json` → write placeholder `body.html` → `spawnTurn(...)` → redirect `/s/:uuid`. POST `/s/:uuid/stop` (199–234): write `stopped.txt` FIRST, `killProcessTree(pid)`, clear `error.txt`, write drain.stop if drain, write `stoppedBody`. POST `/drain` (187–197) → `drain(buildDrainOptsFor(...))`. POST `/s/:uuid/send` (247–308) → drain-resume via `runTurn(worktree)` else `spawnTurn`.
- `src/kill.ts:killProcessTree(pid)` — `process.kill(-pid, SIGTERM)` then SIGKILL escalation. Used by VOS-187 stop.
- `src/drain.ts:drain(opts)` — server-side box loop; spawns each box via `runTurn(cwd=worktree)`; checks `drain.stop` at top of each iteration. `DrainOpts` is callback-injected (fully mockable).

**State (current):**
- `src/sessions.ts:listSessions(vault)` derives `SessionStatus` ∈ {error, stopped, awaiting, complete} purely from filesystem (`stopped.txt`/`error.txt`/`<form` in body.html). The dashboard reads this.
- `src/paths.ts` — `sessionDir`/`bodyPath`/`pidPath`/`stopPath`/`configPath`; `vaultRoot()` = `$VOID_OS_VAULT ?? ~/.void-os`. **No SQLite anywhere in the repo today.** `VoidOsConfig` has `runners`/`defaultRunner`.
- `src/serve.ts:runServe()` → `makeApp(vault)` → `Bun.serve({port, hostname:"0.0.0.0", fetch:app.fetch, idleTimeout:255})`. `resolveVault(env, cwd)` resolves the vault. Default port 4317.
- `src/cli.ts` dispatches `init`/`serve`/`list-sessions`. `tests/server.test.ts` mocks `src/spawn.ts` via `mock.module` — any spawn-signature change must update that mock.

**CC hook contracts (docs.claude.com/en/docs/claude-code/hooks, fetched 2026-06-01):**
- Every hook payload carries common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
- `SessionStart` — fires on session begin/resume. matcher ∈ {`startup`,`resume`,`clear`,`compact`}. Extra fields: `source`, `model`.
- `Stop` — fires once per turn when the main agent finishes responding (NOT on user interrupt; API errors fire `StopFailure`). Extra: `stop_hook_active`, `last_assistant_message`.
- `SessionEnd` — fires once when the session ends. matcher ∈ {`clear`,`resume`,`logout`,`prompt_input_exit`,`other`}. Extra: `reason`.
- `StopFailure` — fires instead of `Stop` on API error. Extra: `error` (∈ rate_limit/authentication_failed/…), `last_assistant_message`.
- Hooks can be `type:"http"` with `{url, headers}` — CC POSTs the payload JSON to the daemon. Configurable in a `settings.json` (`hooks` key, per-event arrays of `{matcher, hooks:[{type,...}]}`).
- tmux 3.6a present at `/opt/homebrew/bin/tmux`; `vc` v0.2.2 at `~/.void-code/bin/vc`.

**State machine (binding, from task `### Agreed design`):**
- spawn → run.state `spawning`
- SessionStart → run.state `running` (+ fill session.resume_token if NULL)
- Stop → run.state `idle`
- process exit / SessionEnd → `exited_ok` (exit 0) / `exited_fail` (non-zero)
- idle-reaper kills stale `idle` Runs → exited (kill-session)

---

## File Structure

- `src/registry.ts` (new) — `bun:sqlite` schema (`runs`, `sessions`), open/migrate, typed insert/update/query helpers. One responsibility: registry persistence + the state-transition writes. Pure, unit-testable against a `:memory:` or tmp-file DB.
- `src/tmux.ts` (new) — thin tmux wrapper: `newRunSession(name, cwd, command, env)`, `killSession(name)`, `hasSession(name)`, `attachCommand(name)`. One responsibility: tmux substrate. Unit-testable against real tmux (3.6a present) with a sleep command.
- `src/hooks-endpoint.ts` (new) — pure handler `handleHookEvent(db, payload)` that maps a CC hook payload → registry state transition. Plus the daemon-owned `settings.json` writer `writeHookSettings(dir, daemonUrl)`. One responsibility: hook→registry mapping. Unit-testable with a fake DB + synthetic payloads.
- `src/reaper.ts` (new) — `reapIdleRuns(db, tmux, nowMs, ttlMs)`: find `idle` Runs older than TTL, kill-session, mark exited. Pure (tmux + clock injected). Unit-testable.
- `src/spawn.ts` (modify) — add `spawnRun(...)` that creates the Run row + tmux session (replaces the headless `spawnTurn` for launches). Keep `runTurn`/`spawnTurn` exports the drain still depends on (Phase 5 migrates drain).
- `src/server.ts` (modify) — `/launch` → `spawnRun`; add POST `/hook` HTTP endpoint; `/s/:uuid/stop` → tmux kill-session + registry exit; expose registry rows to the dashboard; add `attach` affordance.
- `src/paths.ts` (modify) — add `registryDbPath(vault)` + `hookSettingsDir(vault)`.
- `src/serve.ts` (modify) — open the registry DB at boot; start the idle-reaper interval; pass DB into `makeApp`.
- `src/sessions.ts` (modify) — read run/session state from the registry (registry is now the state source), keeping the filesystem body.html for render only.
- `tests/registry.test.ts`, `tests/tmux.test.ts`, `tests/hooks-endpoint.test.ts`, `tests/reaper.test.ts` (new) — unit tests.
- `tests/e2e-vos-188-tmux-run-registry.ts` (new) — real-path proof (Phase 6).

---

## Phasing & shippability

Six phases. Each is committable; the daemon stays bootable after every phase (the legacy `spawnTurn` path is only retired in Phase 5, after the new path is proven).

- **Phase 1 — Registry (`runs`+`sessions` SQLite).** No behavior change; pure persistence layer + helpers. Shippable: new module, no caller yet.
- **Phase 2 — tmux substrate.** `src/tmux.ts`. Shippable: wrapper proven against real tmux, no caller yet.
- **Phase 3 — Hook endpoint + settings writer + state machine.** `/hook` route + mapping. Shippable: endpoint live, driven by synthetic payloads in tests; not yet wired to a real spawn.
- **Phase 4 — `spawnRun` + wire `/launch` + stop = kill-session.** The pivot: launches now create tmux Runs + registry rows; stop kills the session. Shippable: interactive Runs work end-to-end via hooks; legacy `spawnTurn` still present for drains.
- **Phase 5 — Idle-reaper + migrate drain + retire legacy headless launch + dashboard reads registry.** Shippable: full new substrate, no regression in drain/stop.
- **Phase 6 — Real-path proof (E2E) + operator-gated ship.** Spawn a real Run, attach, watch the registry walk states. **PRODUCTION-MUTATING final step** (merge to `main` + redeploy dogfood daemon) — implementer MUST pause with `PROD_ACTION` before push.

---

## Phase 1 — Registry (SQLite `runs` + `sessions`)

### Task 1: Registry schema + open/migrate

**Files:**
- Create: `src/registry.ts`
- Modify: `src/paths.ts` (add `registryDbPath`)
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Add the DB path resolver.** In `src/paths.ts`, after `configPath`:

```ts
export const registryDbPath = (vault: string) => join(vault, ".void-os", "registry.db");
export const hookSettingsDir = (vault: string) => join(vault, ".void-os", "cc");
```

(`~/void/.void/` is the canonical daemon-state zone per CONTEXT.md; we nest under the vault's `.void-os/` to keep it self-contained and test-isolatable.)

- [ ] **Step 2: Write the failing test for schema + enums.** In `tests/registry.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openRegistry, type RunState, type SessionState } from "../src/registry.ts";

test("openRegistry creates runs + sessions tables with expected columns", () => {
  const db = openRegistry(":memory:");
  const runCols = db.query("PRAGMA table_info(runs)").all().map((r: any) => r.name);
  expect(runCols).toEqual(
    expect.arrayContaining(["id", "session_id", "tmux_session", "pid", "state", "started_at", "ended_at"]),
  );
  const sesCols = db.query("PRAGMA table_info(sessions)").all().map((r: any) => r.name);
  expect(sesCols).toEqual(
    expect.arrayContaining(["id", "resume_token", "state", "agent", "skill", "created_at", "last_run_at"]),
  );
  db.close();
});
```

- [ ] **Step 3: Run to confirm it fails.** `bun test tests/registry.test.ts` — expect FAIL (`openRegistry` not found).

- [ ] **Step 4: Implement `openRegistry`.** In `src/registry.ts`:

```ts
import { Database } from "bun:sqlite";

export type RunState = "spawning" | "running" | "idle" | "exited_ok" | "exited_fail";
export type SessionState = "open" | "resumable" | "closed";

export function openRegistry(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      resume_token TEXT,
      state        TEXT NOT NULL DEFAULT 'open',
      agent        TEXT,
      skill        TEXT,
      created_at   INTEGER NOT NULL,
      last_run_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      tmux_session  TEXT NOT NULL,
      pid           INTEGER,
      state         TEXT NOT NULL DEFAULT 'spawning',
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
  `);
  return db;
}
```

- [ ] **Step 5: Run to confirm pass.** `bun test tests/registry.test.ts` — expect PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/registry.ts src/paths.ts tests/registry.test.ts
git commit -m "feat(registry): SQLite runs+sessions schema + openRegistry"
```

### Task 2: Registry insert/transition/query helpers

**Files:**
- Modify: `src/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Write the failing test for the create-session/create-run/transition flow.** Append to `tests/registry.test.ts`:

```ts
import { openRegistry, createSession, createRun, setRunState, setResumeToken,
         getRun, getSession, latestRunForSession } from "../src/registry.ts";

test("createSession + createRun insert rows with starting states", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-1", agent: null, skill: "smoke-test", now: 1000 });
  createRun(db, { id: "run-1", sessionId: "ses-1", tmuxSession: "vos-run-run-1", pid: 42, now: 1000 });
  const r = getRun(db, "run-1");
  expect(r!.state).toBe("spawning");
  expect(r!.tmux_session).toBe("vos-run-run-1");
  expect(getSession(db, "ses-1")!.resume_token).toBeNull();
  db.close();
});

test("setResumeToken fills only when NULL (first SessionStart wins)", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-2", agent: null, skill: "x", now: 1 });
  const first = setResumeToken(db, "ses-2", "cc-uuid-A", 2);
  const second = setResumeToken(db, "ses-2", "cc-uuid-B", 3);
  expect(first).toBe(true);   // filled
  expect(second).toBe(false); // already set, untouched
  expect(getSession(db, "ses-2")!.resume_token).toBe("cc-uuid-A");
  db.close();
});

test("setRunState walks the lifecycle and stamps ended_at on terminal", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-3", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-3", sessionId: "ses-3", tmuxSession: "t", pid: 1, now: 1 });
  setRunState(db, "run-3", "running", 2);
  setRunState(db, "run-3", "idle", 3);
  setRunState(db, "run-3", "exited_ok", 4);
  const r = getRun(db, "run-3");
  expect(r!.state).toBe("exited_ok");
  expect(r!.ended_at).toBe(4);
  expect(latestRunForSession(db, "ses-3")!.id).toBe("run-3");
  db.close();
});
```

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/registry.test.ts` — expect FAIL (helpers undefined).

- [ ] **Step 3: Implement the helpers.** Append to `src/registry.ts`:

```ts
const TERMINAL: ReadonlySet<RunState> = new Set(["exited_ok", "exited_fail"]);

export interface RunRow {
  id: string; session_id: string; tmux_session: string;
  pid: number | null; state: RunState; started_at: number; ended_at: number | null;
}
export interface SessionRow {
  id: string; resume_token: string | null; state: SessionState;
  agent: string | null; skill: string | null; created_at: number; last_run_at: number | null;
}

export function createSession(
  db: Database, a: { id: string; agent: string | null; skill: string | null; now: number },
): void {
  db.query(
    "INSERT INTO sessions (id, resume_token, state, agent, skill, created_at, last_run_at) VALUES (?, NULL, 'open', ?, ?, ?, ?)",
  ).run(a.id, a.agent, a.skill, a.now, a.now);
}

export function createRun(
  db: Database, a: { id: string; sessionId: string; tmuxSession: string; pid: number | null; now: number },
): void {
  db.query(
    "INSERT INTO runs (id, session_id, tmux_session, pid, state, started_at, ended_at) VALUES (?, ?, ?, ?, 'spawning', ?, NULL)",
  ).run(a.id, a.sessionId, a.tmuxSession, a.pid, a.now);
  db.query("UPDATE sessions SET last_run_at = ? WHERE id = ?").run(a.now, a.sessionId);
}

/** Fill resume_token iff currently NULL. Returns true when it filled. */
export function setResumeToken(db: Database, sessionId: string, token: string, now: number): boolean {
  const res = db.query(
    "UPDATE sessions SET resume_token = ?, last_run_at = ? WHERE id = ? AND resume_token IS NULL",
  ).run(token, now, sessionId);
  return res.changes > 0;
}

export function setRunState(db: Database, runId: string, state: RunState, now: number): void {
  if (TERMINAL.has(state)) {
    db.query("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?").run(state, now, runId);
  } else {
    db.query("UPDATE runs SET state = ? WHERE id = ?").run(state, runId);
  }
}

export function getRun(db: Database, id: string): RunRow | null {
  return (db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow) ?? null;
}
export function getSession(db: Database, id: string): SessionRow | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) ?? null;
}
export function latestRunForSession(db: Database, sessionId: string): RunRow | null {
  return (db.query(
    "SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
  ).get(sessionId) as RunRow) ?? null;
}
/** Run lookup by the tmux session name (hook payloads carry CC session_id, not run id — see Task 6). */
export function runByTmuxSession(db: Database, tmux: string): RunRow | null {
  return (db.query("SELECT * FROM runs WHERE tmux_session = ?").get(tmux) as RunRow) ?? null;
}
```

- [ ] **Step 4: Run to confirm pass.** `bun test tests/registry.test.ts` — expect PASS.

- [ ] **Step 5: tsc.** `bunx tsc --noEmit` — expect clean.

- [ ] **Step 6: Commit.**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat(registry): session/run create + state-transition + query helpers"
```

---

## Phase 2 — tmux substrate

### Task 3: tmux wrapper (new-session / kill-session / has-session / attach)

**Files:**
- Create: `src/tmux.ts`
- Test: `tests/tmux.test.ts`

- [ ] **Step 1: Write the failing test against REAL tmux.** In `tests/tmux.test.ts` (tmux 3.6a is installed — these are integration tests, not mocks):

```ts
import { test, expect, afterEach } from "bun:test";
import { newRunSession, killSession, hasSession, attachCommand } from "../src/tmux.ts";

const NAME = "vos-run-test-" + process.pid;
afterEach(() => { try { killSession(NAME); } catch {} });

test("newRunSession starts a detached session that hasSession sees; killSession removes it", () => {
  const pid = newRunSession(NAME, process.cwd(), "sleep 30", {});
  expect(typeof pid).toBe("number");
  expect(hasSession(NAME)).toBe(true);
  killSession(NAME);
  expect(hasSession(NAME)).toBe(false);
});

test("attachCommand returns the canonical attach string", () => {
  expect(attachCommand("vos-run-x")).toBe("tmux attach -t vos-run-x");
});

test("killSession on a missing session is a no-op (no throw)", () => {
  expect(() => killSession("vos-run-nope-" + process.pid)).not.toThrow();
});
```

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/tmux.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement `src/tmux.ts`.** Use `tmux` from PATH (`/opt/homebrew/bin/tmux` on dev; `tmux` resolves on Linux dogfood):

```ts
import { spawnSync } from "node:child_process";

const TMUX = "tmux";

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(TMUX, args, { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Start a detached tmux session named `name` running `command` in `cwd`.
 * Returns the tmux pane PID (the shell/process inside the session) so the
 * registry can record runs.pid. Throws if the session fails to start.
 */
export function newRunSession(
  name: string, cwd: string, command: string, env: Record<string, string>,
): number {
  // -d detached, -s name, -c cwd; command runs in the pane.
  const envPairs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = run(["new-session", "-d", "-s", name, "-c", cwd, ...envPairs, command]);
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  // Pane PID = the process tree root inside the session (for kill/inspection).
  const p = run(["list-panes", "-t", name, "-F", "#{pane_pid}"]);
  const pid = parseInt(p.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) ? pid : -1;
}

export function hasSession(name: string): boolean {
  return run(["has-session", "-t", name]).code === 0;
}

export function killSession(name: string): void {
  // No-op if absent (has-session guards the kill so a missing session never errors).
  if (hasSession(name)) run(["kill-session", "-t", name]);
}

export function attachCommand(name: string): string {
  return `tmux attach -t ${name}`;
}
```

> **Note:** tmux `new-session -e` (per-session env) requires tmux ≥ 3.2; dev host is 3.6a. If the dogfood host is older, fall back to prefixing the command with `env K=V ...`. The implementer must confirm the dogfood tmux version (`tmux -V`) in Phase 6.

- [ ] **Step 4: Run to confirm pass.** `bun test tests/tmux.test.ts` — expect PASS (real sessions created + killed).

- [ ] **Step 5: tsc.** `bunx tsc --noEmit` — expect clean.

- [ ] **Step 6: Commit.**

```bash
git add src/tmux.ts tests/tmux.test.ts
git commit -m "feat(tmux): detached Run-session wrapper (new/kill/has/attach)"
```

---

## Phase 3 — Hook endpoint + settings writer + state machine

### Task 4: Hook→registry mapping (pure handler)

**Files:**
- Create: `src/hooks-endpoint.ts`
- Test: `tests/hooks-endpoint.test.ts`

The hook payload carries CC's `session_id` (the `--session-id`/`--resume` uuid), NOT our run id. We attribute the event to a Run via the tmux session name, which we inject as an env var (`VOS_RUN_ID`) into the Run and have CC echo back. Since hook payloads do NOT include arbitrary env, we instead key on CC's `session_id`: at spawn we set `sessions.id` lookups via `resume_token`. **Resolution (binding for this task):** the daemon writes a per-Run hook settings file whose HTTP hook URL embeds the run id as a path/query param (`/hook?run=<run-id>`), so the daemon attributes every payload to the exact Run regardless of payload contents. The `session_id` in the payload is used only to fill `resume_token`.

- [ ] **Step 1: Write the failing test for the state-machine mapping.** In `tests/hooks-endpoint.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openRegistry, createSession, createRun, getRun, getSession } from "../src/registry.ts";
import { handleHookEvent } from "../src/hooks-endpoint.ts";

function seed() {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-1", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-1", sessionId: "ses-1", tmuxSession: "vos-run-run-1", pid: 1, now: 1 });
  return db;
}

test("SessionStart → run running + fills resume_token from payload session_id", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-uuid-1", source: "startup" }, 10);
  expect(getRun(db, "run-1")!.state).toBe("running");
  expect(getSession(db, "ses-1")!.resume_token).toBe("cc-uuid-1");
});

test("Stop → run idle", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-1", source: "startup" }, 10);
  handleHookEvent(db, "run-1", { hook_event_name: "Stop", session_id: "cc-1", stop_hook_active: false }, 20);
  expect(getRun(db, "run-1")!.state).toBe("idle");
});

test("SessionEnd → run exited_ok", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionEnd", session_id: "cc-1", reason: "prompt_input_exit" }, 30);
  expect(getRun(db, "run-1")!.state).toBe("exited_ok");
});

test("StopFailure → run exited_fail", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "StopFailure", session_id: "cc-1", error: "rate_limit" }, 40);
  expect(getRun(db, "run-1")!.state).toBe("exited_fail");
});

test("a second resume on the same session reuses the existing resume_token", () => {
  const db = seed();
  handleHookEvent(db, "run-1", { hook_event_name: "SessionStart", session_id: "cc-1", source: "startup" }, 10);
  // a fresh Run on the same session resumes the same CC uuid
  createRun(db, { id: "run-2", sessionId: "ses-1", tmuxSession: "vos-run-run-2", pid: 2, now: 50 });
  handleHookEvent(db, "run-2", { hook_event_name: "SessionStart", session_id: "cc-1", source: "resume" }, 51);
  expect(getSession(db, "ses-1")!.resume_token).toBe("cc-1"); // unchanged
  expect(getRun(db, "run-2")!.state).toBe("running");
});
```

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/hooks-endpoint.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement the handler.** In `src/hooks-endpoint.ts`:

```ts
import type { Database } from "bun:sqlite";
import { getRun, setRunState, setResumeToken } from "./registry.ts";

export interface HookPayload {
  hook_event_name: string;
  session_id?: string;
  source?: string;
  reason?: string;
  error?: string;
  stop_hook_active?: boolean;
}

/**
 * Map one CC hook event to a registry transition for the given run.
 * `runId` is supplied by the daemon (from the /hook?run=<id> route), NOT the payload.
 * Unknown events and unknown runs are ignored (no throw — hooks must never 500).
 */
export function handleHookEvent(db: Database, runId: string, p: HookPayload, now: number): void {
  const run = getRun(db, runId);
  if (!run) return; // unknown run — ignore
  switch (p.hook_event_name) {
    case "SessionStart":
      setRunState(db, runId, "running", now);
      if (p.session_id) setResumeToken(db, run.session_id, p.session_id, now);
      break;
    case "Stop":
      setRunState(db, runId, "idle", now);
      break;
    case "SessionEnd":
      setRunState(db, runId, "exited_ok", now);
      break;
    case "StopFailure":
      setRunState(db, runId, "exited_fail", now);
      break;
    default:
      // PreToolUse/PostToolUse/etc. — not part of the lifecycle machine; ignore.
      break;
  }
}
```

- [ ] **Step 4: Run to confirm pass.** `bun test tests/hooks-endpoint.test.ts` — expect PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/hooks-endpoint.ts tests/hooks-endpoint.test.ts
git commit -m "feat(hooks): CC-hook→registry state-machine mapping"
```

### Task 5: Hook settings writer

**Files:**
- Modify: `src/hooks-endpoint.ts`
- Test: `tests/hooks-endpoint.test.ts`

- [ ] **Step 1: Write the failing test for the settings JSON shape.** Append to `tests/hooks-endpoint.test.ts`:

```ts
import { buildHookSettings } from "../src/hooks-endpoint.ts";

test("buildHookSettings wires SessionStart/Stop/SessionEnd/StopFailure to the daemon /hook url for this run", () => {
  const s = buildHookSettings("http://127.0.0.1:4317", "run-1");
  const events = Object.keys(s.hooks);
  expect(events).toEqual(
    expect.arrayContaining(["SessionStart", "Stop", "SessionEnd", "StopFailure"]),
  );
  const h = s.hooks.SessionStart[0].hooks[0];
  expect(h.type).toBe("http");
  expect(h.url).toBe("http://127.0.0.1:4317/hook?run=run-1");
});
```

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/hooks-endpoint.test.ts -t buildHookSettings` — expect FAIL.

- [ ] **Step 3: Implement `buildHookSettings` + `writeHookSettings`.** Append to `src/hooks-endpoint.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIFECYCLE_EVENTS = ["SessionStart", "Stop", "SessionEnd", "StopFailure"] as const;

export interface CcHookSettings {
  hooks: Record<string, { hooks: { type: "http"; url: string }[] }[]>;
}

/** Build a CC settings.json `hooks` block: every lifecycle event POSTs to /hook?run=<runId>. */
export function buildHookSettings(daemonUrl: string, runId: string): CcHookSettings {
  const url = `${daemonUrl}/hook?run=${runId}`;
  const hooks: CcHookSettings["hooks"] = {};
  for (const ev of LIFECYCLE_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: "http", url }] }];
  }
  return { hooks };
}

/**
 * Write a per-Run settings.json into `dir` and return its path. The Run is launched
 * with `claude --settings <path>` (or CLAUDE settings env) so these hooks are scoped
 * to exactly this Run — no global settings.json mutation.
 */
export function writeHookSettings(dir: string, daemonUrl: string, runId: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.settings.json`);
  writeFileSync(path, JSON.stringify(buildHookSettings(daemonUrl, runId), null, 2));
  return path;
}
```

> **Implementer discovery (Phase 4):** confirm the exact flag `vc`/`claude` accepts to load a settings file for a single invocation (candidates: `--settings <file>`, or `CLAUDE_SETTINGS`/project `.claude/settings.json` written into the Run's cwd). Verify hooks actually fire by running a real Run and watching the daemon receive the POST. The settings *content* (this task) is settled; only the *delivery flag* is a discovery item.

- [ ] **Step 4: Run to confirm pass.** `bun test tests/hooks-endpoint.test.ts` — expect PASS.

- [ ] **Step 5: tsc + full suite.** `bunx tsc --noEmit && bun test` — expect clean/green.

- [ ] **Step 6: Commit.**

```bash
git add src/hooks-endpoint.ts tests/hooks-endpoint.test.ts
git commit -m "feat(hooks): per-Run CC settings.json writer (http hooks → daemon /hook)"
```

### Task 6: `/hook` HTTP route on the daemon

**Files:**
- Modify: `src/server.ts` (add route; thread `db` into `makeApp`)
- Modify: `src/serve.ts` (open registry, pass `db`)
- Modify: `tests/server.test.ts` (provide a `db` to `makeApp`)
- Test: `tests/server.test.ts`

- [ ] **Step 1: Change `makeApp` to accept the registry DB.** In `src/server.ts`, change the signature:

```ts
import type { Database } from "bun:sqlite";
import { handleHookEvent, type HookPayload } from "./hooks-endpoint.ts";
// ...
export function makeApp(vault: string, db: Database) {
  const app = new Hono();
  // ... existing routes ...
```

- [ ] **Step 2: Add the `/hook` route** (place it among the POST routes):

```ts
  // POST /hook?run=<run-id> — CC HTTP hook sink. Maps a lifecycle event to a registry
  // transition. Always 200 (a hook must never see a 5xx — it would stall the Run).
  app.post("/hook", async (c) => {
    const runId = c.req.query("run") ?? "";
    let payload: HookPayload;
    try { payload = (await c.req.json()) as HookPayload; }
    catch { return c.json({ ok: false }, 200); }
    try { handleHookEvent(db, runId, payload, Date.now()); }
    catch { /* never fail a hook */ }
    return c.json({ ok: true }, 200);
  });
```

- [ ] **Step 3: Open the DB in `serve.ts` and pass it.** In `src/serve.ts`, before `makeApp(vault)`:

```ts
import { openRegistry } from "./registry.ts";
import { registryDbPath } from "./paths.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// ...
  mkdirSync(dirname(registryDbPath(vault)), { recursive: true });
  const db = openRegistry(registryDbPath(vault));
  const app = makeApp(vault, db);
```

- [ ] **Step 4: Write the failing route test.** In `tests/server.test.ts` (open an in-memory DB, seed a run, POST a SessionStart):

```ts
import { openRegistry, createSession, createRun, getRun } from "../src/registry.ts";

test("POST /hook?run=<id> with SessionStart flips the run to running", async () => {
  const vault = "/tmp/void-os-hook-route-test";
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-h", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-h", sessionId: "ses-h", tmuxSession: "vos-run-run-h", pid: 1, now: 1 });
  const app = makeApp(vault, db);
  const res = await app.request("/hook?run=run-h", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-x", source: "startup" }),
  });
  expect(res.status).toBe(200);
  expect(getRun(db, "run-h")!.state).toBe("running");
});
```

(Update every other `makeApp(vault)` call in `tests/server.test.ts` to `makeApp(vault, openRegistry(":memory:"))`.)

- [ ] **Step 5: Run to confirm it fails, then passes after the edits.** `bun test tests/server.test.ts -t "POST /hook"` — FAIL first (route absent / arity), then PASS.

- [ ] **Step 6: tsc + full suite.** `bunx tsc --noEmit && bun test` — green. Fix any `makeApp` arity mismatches surfaced.

- [ ] **Step 7: Commit.**

```bash
git add src/server.ts src/serve.ts tests/server.test.ts
git commit -m "feat(server): /hook HTTP sink + registry DB threaded into makeApp"
```

---

## Phase 4 — `spawnRun` + wire `/launch` + stop = kill-session

### Task 7: `spawnRun` — create Run row + tmux session + hook settings

**Files:**
- Modify: `src/spawn.ts` (add `spawnRun`; keep `spawnTurn`/`runTurn` for now)
- Modify: `src/paths.ts` (already has `hookSettingsDir` from Task 1)
- Test: `tests/spawn.test.ts`

`spawnRun` is the new launch primitive. It: mints a run id, creates the session+run rows (state `spawning`), writes the per-Run hook settings, then `tmux new-session` running the interactive `vc`/`claude` command (with `--session-id <ourSessionResumeSeed>` for a fresh Session OR `--resume <token>` for a subsequent Run) + the settings flag. It records `pid` + `tmux_session`.

- [ ] **Step 1: Write the failing test (real tmux + in-memory DB).** In `tests/spawn.test.ts`:

```ts
import { test, expect, afterEach } from "bun:test";
import { openRegistry, getRun, getSession, latestRunForSession } from "../src/registry.ts";
import { spawnRun } from "../src/spawn.ts";
import { killSession, hasSession } from "../src/tmux.ts";

let started: string[] = [];
afterEach(() => { for (const n of started) { try { killSession(n); } catch {} } started = []; });

test("spawnRun creates session+run rows and a live tmux session in 'spawning'", () => {
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-spawnrun-test";
  // runner command 'sleep 30' stands in for interactive vc; we assert substrate + rows, not CC behavior.
  const { runId, sessionId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "smoke-test", agent: null, runnerCommand: "sleep 30", now: 1000,
  });
  started.push(tmuxSession);
  expect(tmuxSession).toBe(`vos-run-${runId}`);
  expect(hasSession(tmuxSession)).toBe(true);
  expect(getRun(db, runId)!.state).toBe("spawning");
  expect(getSession(db, sessionId)!.resume_token).toBeNull();
  expect(latestRunForSession(db, sessionId)!.id).toBe(runId);
});
```

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/spawn.test.ts -t spawnRun` — expect FAIL.

- [ ] **Step 3: Implement `spawnRun`.** In `src/spawn.ts` (add imports for `randomUUID`, registry, tmux, hooks-endpoint, paths):

```ts
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createSession, createRun, getSession } from "./registry.ts";
import { newRunSession } from "./tmux.ts";
import { writeHookSettings } from "./hooks-endpoint.ts";
import { hookSettingsDir } from "./paths.ts";

export interface SpawnRunOpts {
  db: Database; vault: string; daemonUrl: string;
  skill: string; agent: string | null; runnerCommand: string;
  now: number;
  /** When set, this Run resumes an existing Session (subsequent Run); else a fresh Session. */
  sessionId?: string;
}

/**
 * Spawn a Run: create/resolve the Session, insert a 'spawning' run row, write per-Run CC
 * hook settings, and launch interactive CC inside a named tmux session `vos-run-<run-id>`.
 * Returns the ids + tmux session name. The run.state machine advances from the /hook endpoint.
 */
export function spawnRun(opts: SpawnRunOpts): { runId: string; sessionId: string; tmuxSession: string } {
  const runId = randomUUID();
  const sessionId = opts.sessionId ?? randomUUID();
  if (!opts.sessionId) {
    createSession(opts.db, { id: sessionId, agent: opts.agent, skill: opts.skill, now: opts.now });
  }
  const tmuxSession = `vos-run-${runId}`;
  const settingsPath = writeHookSettings(hookSettingsDir(opts.vault), opts.daemonUrl, runId);

  // Fresh Session → --session-id <ccSeed>; resume → --resume <token>.
  const ses = getSession(opts.db, sessionId);
  const ccSeed = randomUUID(); // CC's own session uuid for a fresh thread
  const sessionArg = ses?.resume_token
    ? ["--resume", ses.resume_token]
    : ["--session-id", ccSeed];
  const prompt = opts.skill ? `/${opts.skill}` : "";
  // Interactive launch (NO -p): CC stays attached in the tmux pane. --settings scopes hooks to this Run.
  // NOTE: confirm the exact settings flag in Phase 6 against vc v0.2.2 / claude (see Task 5 discovery note).
  const argv = [...sessionArg, "--settings", settingsPath, "--permission-mode", "bypassPermissions",
                ...(prompt ? [prompt] : [])];
  const toks = tokenizeCommand(opts.runnerCommand);
  const fullCommand = [...toks, ...argv].map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");

  const pid = newRunSession(tmuxSession, opts.vault, fullCommand, { VOID_OS_SESSION: sessionId, VOS_RUN_ID: runId });
  createRun(opts.db, { id: runId, sessionId, tmuxSession, pid, now: opts.now });
  return { runId, sessionId, tmuxSession };
}
```

> **Implementer note:** the `sleep 30` test runner proves the substrate + rows. The real `runnerCommand` is the vault's configured runner (`vc --`); replacing `-p /<skill>` with an interactive `/<skill>` is the behavioral pivot. Phase 6 proves a real CC Run.

- [ ] **Step 4: Run to confirm pass.** `bun test tests/spawn.test.ts -t spawnRun` — expect PASS (real tmux session created, rows present).

- [ ] **Step 5: tsc.** `bunx tsc --noEmit` — clean.

- [ ] **Step 6: Commit.**

```bash
git add src/spawn.ts tests/spawn.test.ts
git commit -m "feat(spawn): spawnRun — tmux Run + registry rows + per-Run hook settings"
```

### Task 8: Wire `/launch` to `spawnRun`; stop = kill-session + registry exit

**Files:**
- Modify: `src/server.ts` (`/launch`, `/s/:uuid/stop`)
- Test: `tests/server.test.ts`

The dashboard keys sessions by a uuid in the URL (`/s/:uuid`). To preserve routing + the existing body.html render shell, **use the Run's `sessionId` as the `/s/:uuid` key** (one Session = one dashboard entry; Runs are its lifecycle). The legacy `spawnTurn` headless path is retired in Phase 5; here `/launch` switches to `spawnRun`.

- [ ] **Step 1: Write the failing test — `/launch` creates a registry session + a live tmux Run, redirects to `/s/<sessionId>`.** In `tests/server.test.ts`:

```ts
test("POST /launch spawns a tmux Run + registry rows and redirects to /s/<sessionId>", async () => {
  const vault = "/tmp/void-os-launch-run-test";
  const db = openRegistry(":memory:");
  // realDeps.vcStatus must report authed; tests already stub it — keep that stub.
  const app = makeApp(vault, db);
  const res = await app.request("/launch", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "skill=smoke-test&text=",
  });
  expect(res.status).toBe(302);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/s\//);
  const sessionId = loc.split("/s/")[1];
  expect(getSession(db, sessionId)).not.toBeNull();
  // cleanup tmux
  const run = latestRunForSession(db, sessionId)!;
  killSession(run.tmux_session);
});
```

(The test relies on the relay-auth stub already in `tests/server.test.ts`. If the suite stubs `realDeps.vcStatus`, keep it; if a real `vc status` call would fire, gate this test behind that stub. The implementer reuses the existing pattern.)

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/server.test.ts -t "POST /launch spawns a tmux Run"` — expect FAIL.

- [ ] **Step 3: Rewrite the `/launch` handler body** to use `spawnRun` (replace the `spawnTurn` block, lines ~85–97):

```ts
    const body = await c.req.parseBody();
    const skill = String(body.skill ?? "");
    const text = String(body.text ?? "");
    const runnerLabel = String(body.runner ?? "");
    const runnerCommand = resolveRunner(readConfig(vault), runnerLabel || undefined);
    const daemonUrl = `http://127.0.0.1:${readConfig(vault).port}`;
    const { sessionId, tmuxSession } = spawnRun({
      db, vault, daemonUrl, skill, agent: null, runnerCommand, now: Date.now(),
    });
    // Keep the body.html render shell working: seed a placeholder + meta under the sessionId key.
    const dir = sessionDir(vault, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session-meta.json"),
      JSON.stringify({ skill, launchedAt: Date.now(), text, tmuxSession }));
    writeFileSync(bodyPath(vault, sessionId), placeholderBody(skill));
    return c.redirect(`/s/${sessionId}`);
```

(Add `import { spawnRun } from "./spawn.ts";` — already imported from spawn.ts module.)

- [ ] **Step 4: Rewrite `/s/:uuid/stop`** so stop = `tmux kill-session` + registry exit (the `:uuid` is the sessionId):

```ts
  app.post("/s/:uuid/stop", async (c) => {
    const sessionId = c.req.param("uuid");
    if (existsSync(stopPath(vault, sessionId))) return c.redirect("/"); // idempotent
    writeFileSync(stopPath(vault, sessionId), "stopped\n");
    // Kill the latest Run's tmux session + mark the run exited in the registry.
    const run = latestRunForSession(db, sessionId);
    if (run && run.state !== "exited_ok" && run.state !== "exited_fail") {
      killSession(run.tmux_session);          // tmux kill-session = stop (folds VOS-187 stop semantics)
      setRunState(db, run.id, "exited_fail", Date.now()); // operator-stopped = non-clean exit
    }
    try { rmSync(errorPath(vault, sessionId)); } catch { /* none */ }
    // Drain halt (preserve VOS-187 behavior): if this session belongs to a drain, flag it.
    let skill = "";
    const metaPath = join(sessionDir(vault, sessionId), "session-meta.json");
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string; drainIssue?: number; worktree?: string };
        skill = m.skill ?? "";
        if (typeof m.drainIssue === "number" && m.worktree) writeFileSync(join(m.worktree, "drain.stop"), "1");
      } catch { /* ignore */ }
    }
    writeFileSync(bodyPath(vault, sessionId), stoppedBody(skill));
    return c.redirect("/");
  });
```

(Add imports: `latestRunForSession`, `setRunState` from `./registry.ts`. `killSession` from `./tmux.ts`. Keep `killProcessTree` import only if still used by the drain stop path — Phase 5 reconciles.)

- [ ] **Step 5: Run to confirm pass.** `bun test tests/server.test.ts -t "POST /launch spawns a tmux Run"` and the stop tests — expect PASS.

- [ ] **Step 6: tsc + full suite.** `bunx tsc --noEmit && bun test` — green. The VOS-187 stop e2e expectations that asserted `process.kill` tree-kill will need re-pointing to kill-session in Phase 6's e2e; unit tests here assert the registry exit + tmux gone.

- [ ] **Step 7: Commit.**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): /launch → spawnRun (tmux); stop → kill-session + registry exit"
```

---

## Phase 5 — idle-reaper + migrate drain + retire legacy launch + dashboard reads registry

### Task 9: Idle-reaper

**Files:**
- Create: `src/reaper.ts`
- Modify: `src/serve.ts` (start the reaper interval)
- Test: `tests/reaper.test.ts`

- [ ] **Step 1: Write the failing test (injected clock + tmux stub).** In `tests/reaper.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openRegistry, createSession, createRun, setRunState, getRun } from "../src/registry.ts";
import { reapIdleRuns } from "../src/reaper.ts";

test("reapIdleRuns kills + exits an idle run older than TTL, leaves a fresh idle run alone", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s", agent: null, skill: "x", now: 0 });
  createRun(db, { id: "stale", sessionId: "s", tmuxSession: "vos-run-stale", pid: 1, now: 0 });
  createRun(db, { id: "fresh", sessionId: "s", tmuxSession: "vos-run-fresh", pid: 2, now: 0 });
  setRunState(db, "stale", "idle", 0);     // idle since t=0
  setRunState(db, "fresh", "idle", 9_000); // idle since t=9000
  const killed: string[] = [];
  reapIdleRuns(db, { killSession: (n) => killed.push(n) }, 10_000, 5_000); // now=10000, ttl=5000
  expect(killed).toEqual(["vos-run-stale"]);
  expect(getRun(db, "stale")!.state).toBe("exited_ok");
  expect(getRun(db, "fresh")!.state).toBe("idle");
});
```

> **Note:** "idle since" = the `started_at`-of-idle. The registry doesn't store a per-state timestamp today; the reaper keys off `ended_at IS NULL AND state='idle'` and a separate `idle_since`. **Add an `idle_since` column write in `setRunState` when transitioning to `idle`** (see Step 3) so the reaper has a clock to compare. Update the Task 2 `setRunState` accordingly + the registry schema (`runs.idle_since INTEGER`). Adjust the Task-1 schema test to include `idle_since`.

- [ ] **Step 2: Add `idle_since` to the schema + `setRunState`.** In `src/registry.ts`: add `idle_since INTEGER` to the `runs` CREATE TABLE; in `setRunState`, when `state==='idle'` also `SET idle_since = ?`. Extend the Task-1 schema test's `arrayContaining` to include `"idle_since"`. Run `bun test tests/registry.test.ts` — green.

- [ ] **Step 3: Run the reaper test to confirm it fails.** `bun test tests/reaper.test.ts` — expect FAIL.

- [ ] **Step 4: Implement `reapIdleRuns`.** In `src/reaper.ts`:

```ts
import type { Database } from "bun:sqlite";
import { setRunState } from "./registry.ts";

export interface TmuxLike { killSession(name: string): void; }

/** Kill + exit any 'idle' Run whose idle_since is older than ttlMs. */
export function reapIdleRuns(db: Database, tmux: TmuxLike, nowMs: number, ttlMs: number): void {
  const stale = db.query(
    "SELECT id, tmux_session FROM runs WHERE state = 'idle' AND idle_since IS NOT NULL AND idle_since <= ?",
  ).all(nowMs - ttlMs) as { id: string; tmux_session: string }[];
  for (const r of stale) {
    tmux.killSession(r.tmux_session);
    setRunState(db, r.id, "exited_ok", nowMs); // reaped cleanly
  }
}
```

- [ ] **Step 5: Run to confirm pass.** `bun test tests/reaper.test.ts` — expect PASS.

- [ ] **Step 6: Start the reaper in `serve.ts`.** After the DB is opened:

```ts
import { reapIdleRuns } from "./reaper.ts";
import { killSession } from "./tmux.ts";
// ...
  const IDLE_TTL_MS = 30 * 60_000; // 30 min idle Runs reaped (resume-by-affinity on next interaction)
  setInterval(() => { try { reapIdleRuns(db, { killSession }, Date.now(), IDLE_TTL_MS); } catch {} }, 60_000);
```

- [ ] **Step 7: tsc + full suite.** `bunx tsc --noEmit && bun test` — green.

- [ ] **Step 8: Commit.**

```bash
git add src/reaper.ts src/registry.ts src/serve.ts tests/reaper.test.ts tests/registry.test.ts
git commit -m "feat(reaper): idle-Run reaper (idle_since TTL → kill-session + exited)"
```

### Task 10: Migrate drain to the Run substrate (preserve VOS-185 behavior)

**Files:**
- Modify: `src/drain.ts` and/or `src/server.ts` (`buildDrainOptsFor`, `/drain`, `/s/:uuid/send` drain-resume)
- Test: `tests/drain.test.ts`, `tests/server.test.ts`

The drain loop (`src/drain.ts`) spawns each box via `runTurn(cwd=worktree)` (headless, awaitable) — this is correct for the gated loop (the runner awaits each box). **Decision:** drain stays on the awaitable headless `runTurn` path (a drain box is a one-shot non-interactive turn; tmux/interactive adds nothing). What changes: a drain that is **stopped** must use the new kill-session path only if it created a tmux Run. Since drain boxes do NOT create tmux Runs, the existing `drain.stop` + `killProcessTree(pid)` halt path for drains is preserved unchanged. The ONLY migration: `/s/:uuid/stop` must still halt a drain (already handled in Task 8 Step 4 via the `drain.stop` write) AND still kill the in-flight `runTurn` child (keep `killProcessTree` for the drain-owned `vc.pid`).

- [ ] **Step 1: Add a regression test that drain stop still halts.** In `tests/drain.test.ts`, confirm the existing "drain clears a stale drain.stop" + mid-run halt tests still pass unchanged: `bun test tests/drain.test.ts` — expect PASS (no code change yet; this is the regression gate).

- [ ] **Step 2: Reconcile the stop route for drains.** In `src/server.ts` `/s/:uuid/stop` (Task 8), when the session is drain-owned (`drainIssue` present in meta) AND a `vc.pid` exists, also `killProcessTree(pid)` (keep the VOS-187 tree-kill for the headless drain child) in addition to the `drain.stop` flag. Add the guarded block:

```ts
    // Drain-owned Runs are headless (runTurn), not tmux — keep the VOS-187 tree-kill for the in-flight child.
    const pp = pidPath(vault, sessionId);
    if (existsSync(pp)) {
      const pid = parseInt(readFileSync(pp, "utf8"), 10);
      if (Number.isFinite(pid)) await killProcessTree(pid);
      try { rmSync(pp); } catch { /* ignore */ }
    }
```

(Restore the `killProcessTree`/`pidPath` imports if Task 8 removed them.)

- [ ] **Step 3: Verify the drain-resume `/send` path is untouched** (it uses `runTurn(worktree)` + re-invokes `drain()`): `bun test tests/server.test.ts -t drain` — expect PASS (no change to that handler).

- [ ] **Step 4: tsc + full suite.** `bunx tsc --noEmit && bun test` — green. Both interactive Runs (tmux + registry) and drain Runs (headless + drain.stop) coexist; stop halts both.

- [ ] **Step 5: Commit.**

```bash
git add src/server.ts tests/drain.test.ts tests/server.test.ts
git commit -m "feat(stop): unified stop — kill-session for tmux Runs, tree-kill for drain children"
```

### Task 11: Dashboard reads the registry (registry is the state source)

**Files:**
- Modify: `src/sessions.ts` (join registry run.state into the session list)
- Modify: `src/server.ts` (`GET /` passes db-derived state; `GET /s/:uuid` shows `attach` command)
- Test: `tests/sessions.test.ts`, `tests/render.test.ts`

- [ ] **Step 1: Write the failing test — listSessions reflects registry run.state.** In `tests/sessions.test.ts`:

```ts
import { listSessions } from "../src/sessions.ts";
import { openRegistry, createSession, createRun, setRunState } from "../src/registry.ts";
// (adapt to listSessions' new signature: listSessions(vault, db))

test("listSessions surfaces the latest Run's registry state + attach command", () => {
  const vault = "/tmp/void-os-sessions-reg-test";
  // ... mkdir sessions/<sessionId>/body.html via existing fixture helper ...
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-reg", agent: null, skill: "smoke", now: 1 });
  createRun(db, { id: "run-reg", sessionId: "ses-reg", tmuxSession: "vos-run-run-reg", pid: 1, now: 1 });
  setRunState(db, "run-reg", "running", 2);
  const list = listSessions(vault, db);
  const s = list.find((x) => x.uuid === "ses-reg");
  expect(s!.runState).toBe("running");
  expect(s!.attach).toBe("tmux attach -t vos-run-run-reg");
});
```

> **Discovery for implementer:** read the current `tests/sessions.test.ts` fixture pattern for creating `sessions/<uuid>/body.html` and reuse it verbatim. `listSessions` keeps deriving the render `status` from filesystem (body.html) for the body iframe; it ADDS `runState`/`attach` from the registry. Do not delete the filesystem-derived `status` — the body.html render shell still uses it.

- [ ] **Step 2: Run to confirm it fails.** `bun test tests/sessions.test.ts -t "registry state"` — expect FAIL.

- [ ] **Step 3: Extend `listSessions` to accept `db` and join the latest Run.** In `src/sessions.ts`: add `runState?: RunState` + `attach?: string` to `SessionInfo`; change signature to `listSessions(vault: string, db: Database)`; for each session dir, look up `latestRunForSession(db, uuid)` and set `runState` = its `state`, `attach` = `attachCommand(run.tmux_session)`.

- [ ] **Step 4: Update callers.** `src/server.ts` `GET /` → `listSessions(vault, db)`; `src/cli.ts` `list-sessions` branch → open the registry + pass `db`. `GET /s/:uuid` shell shows the `attach` string (e.g. a copyable `tmux attach -t vos-run-<id>` line). Update `renderDashboard`/`renderShell` signatures + `tests/render.test.ts` to display `runState` + the attach command.

- [ ] **Step 5: Run to confirm pass + full suite.** `bunx tsc --noEmit && bun test` — green. Fix any caller-arity / render-test breakage.

- [ ] **Step 6: Retire the legacy headless launch.** Confirm `spawnTurn` is now used ONLY by the non-drain answer path (`/s/:uuid/send`). **Decision:** the interactive Run substrate means `/send` should also resume via a tmux Run (`spawnRun({ sessionId, ... })`) rather than headless `spawnTurn`. Migrate `/send` (non-drain branch) to `spawnRun({ db, vault, daemonUrl, skill, agent:null, runnerCommand, now, sessionId })` so an answer-back reuses the Session's resume_token in a fresh interactive Run. Keep `spawnTurn` exported only if a test still needs it; otherwise mark it deprecated. Update the `/send` test accordingly. `bun test tests/server.test.ts` — green.

- [ ] **Step 7: Commit.**

```bash
git add src/sessions.ts src/server.ts src/cli.ts src/render.ts tests/sessions.test.ts tests/render.test.ts
git commit -m "feat(dashboard): registry is the state source — runState + attach; /send → interactive Run"
```

---

## Phase 6 — Real-path proof (E2E) + operator-gated ship

### Task 12: Real-path proof — spawn a real CC Run, attach, watch the registry walk states

**Files:**
- Create: `tests/e2e-vos-188-tmux-run-registry.ts`

> **This task runs a REAL `vc`/CC Run** (relay auth required — confirm `vc status` ok first). It is the binding `## Done when` real-path proof.

- [ ] **Step 1: Confirm prerequisites.** `tmux -V` (record version — confirms `-e` per-session env support ≥3.2; dev is 3.6a), `vc status` (relay authed), `bun run verify` green on the branch.

- [ ] **Step 2: Confirm the settings-flag delivery.** Launch one real Run via `spawnRun` with the real runner command and the per-Run `--settings <file>`; `tmux attach -t vos-run-<id>` to confirm CC is interactive in the pane; from a second shell, `curl`-equivalent is NOT needed — instead assert the daemon `/hook` endpoint received a `SessionStart` POST (check `getRun(db, runId).state === 'running'`). **If the `--settings` flag does not load the hooks** (no POST arrives), fall back to writing `<vault>/.claude/settings.json` (project-scoped) and relaunch; record which mechanism worked.

- [ ] **Step 3: Write the e2e proof script.** In `tests/e2e-vos-188-tmux-run-registry.ts` (standalone `bun run`, follows the sibling e2e harness pattern — read `tests/e2e-vos-187-harden-stop-modal.ts` for the spawn-server + poll pattern):

```ts
// Spawns the daemon on a test port + vault, POSTs /launch with a fast real skill (e.g. smoke-test),
// then polls the registry DB until the latest Run for the session walks spawning→running→idle→exited.
// Asserts EACH transition came from a real hook fire (the daemon /hook POST), NOT capture-pane.
// Also asserts: tmux session vos-run-<id> exists while running; gone after exit; resume_token filled
// on first SessionStart; a second /send Run reuses the same resume_token.
// Prints the attach command + a transition log to stdout as captured evidence.
```

The script must:
1. Start `bun run src/cli.ts serve` on a tmp vault + free port.
2. POST `/launch?skill=smoke-test`.
3. Poll the registry (`openRegistry(registryDbPath(vault))` read-only) every 500ms; record each `latestRunForSession(...).state` transition + timestamp.
4. Assert the sequence contains `spawning` → `running` (from SessionStart hook) → `idle` (Stop hook) → `exited_ok`/`exited_fail` (SessionEnd).
5. Assert `getSession(...).resume_token` is non-NULL after `running`.
6. POST `/s/<sessionId>/send` with a follow-up; assert a second Run row appears reusing the same `resume_token`.
7. POST `/s/<sessionId>/stop` on a fresh Run; assert `tmux has-session` returns absent + run row `exited_fail`.
8. Print the full transition log + `tmux attach -t vos-run-<id>` line to stdout.

- [ ] **Step 4: Run the proof.** `bun run tests/e2e-vos-188-tmux-run-registry.ts` — expect the full state walk printed + all assertions PASS. Capture stdout (the transition log) as evidence; capture a `tmux ls` snapshot + an `attach` screenshot/log.

- [ ] **Step 5: VOS-185/187 regression smoke.** Run the existing e2e specs (`bun run tests/e2e-vos-187-harden-stop-modal.ts`) adapted to the kill-session stop (the tree-kill assertion becomes a `tmux has-session` absent assertion). Confirm drain still halts on stop (`tests/drain.test.ts` green). Capture evidence.

- [ ] **Step 6: Commit the e2e.**

```bash
git add tests/e2e-vos-188-tmux-run-registry.ts
git commit -m "test(e2e): VOS-188 real-path proof — Run walks spawning→running→idle→exited via real hooks"
```

### Task 13: Operator-gated ship — merge to main, redeploy dogfood daemon

> **PRODUCTION-MUTATING — operator-gates-prod.** This merges to `main` and restarts the dogfood void-os daemon. The implementer MUST pause with `PROD_ACTION` (STOP-before-push) and surface the live review BEFORE pushing/merging. No push without operator ship-ack.

**Files:** none (integration + deploy).

- [ ] **Step 1: Confirm green end-to-end.** From the worktree: `bun run verify` green, e2e proof passes, `git status` clean, `git log --oneline main..HEAD` shows the VOS-188 commits.

- [ ] **Step 2: PROD_ACTION pause — surface the live review.** Start the daemon from the worktree on its port; give the operator the live URL + review brief (what to click: launch a skill → see it appear with `running` state + an `attach` command; `tmux attach -t vos-run-<id>` to drop into the live CC; Stop → session gone from tmux + shows exited; confirm the dashboard state matches the registry, not a scrape). DO NOT merge/push. Wait for explicit ship-ack.

- [ ] **Step 3: On ship-ack — merge + push.** `git checkout main && git merge --no-ff <task-branch> && git push origin main`. If the dogfood daemon runs from a global clone, sync per the daemon-split lesson (`feedback_void_os_dogfood_daemon_split`): the daemon does NOT auto-deploy; manually sync `~/.bun/install/global/node_modules/void-os` (or the dogfood clone path) to the merged `main`.

- [ ] **Step 4: Redeploy + post-deploy verify.** Restart the dogfood daemon on `main`; spawn a real Run on the deployed build; confirm the registry walks states + attach works. Capture a post-deploy transition log + screenshot.

- [ ] **Step 5: `/done`** with the Work Log (e2e transition-log evidence, deploy SHA, live URL, regression-smoke result).

---

## Self-Review (planner)

**Spec coverage (`## Done when`):**
1. `runs`+`sessions` tables with agreed columns + enums → Task 1 (+ `idle_since` added Task 9).
2. Spawning a Run → named tmux `vos-run-<run-id>` + live CC + `runs` row (`spawning`→`running`) + parent `sessions` row → Task 7 (substrate + rows) + Task 8 (`/launch` wiring) + Task 4 (running transition).
3. CC hooks drive run.state, verified by reading the registry row (NOT capture-pane) → Task 4 (mapping) + Task 6 (`/hook` route) + Task 12 (real-hook proof).
4. `session.resume_token` NULL at spawn, filled by first SessionStart, reused by a second Run (`--resume`) → Task 2 (`setResumeToken` NULL-guard) + Task 4 + Task 7 (`--resume` branch) + Task 12 (second-Run proof).
5. kill-session stops the Run (tmux gone, row → exited); idle-reaper transitions stale idle → exited → Task 8 (stop=kill-session) + Task 9 (reaper).
6. VOS-185 drain + VOS-187 stop survive → Task 10 (drain on headless `runTurn` preserved; unified stop) + Task 12 Step 5 (regression smoke).
7. Real-path proof: real Run, attach, registry walk from real hooks, evidence captured → Task 12.

**Sequencing:** Phases 1–3 are independent building blocks (registry / tmux / hooks) — could be built in parallel, but kept serial for a single implementer and because Phase 4 depends on all three. Phase 4 depends on 1+2+3. Phase 5 depends on 4. Phase 6 depends on 5.

**Shippability:** daemon boots after every phase (legacy `spawnTurn` retired only in Phase 5, after the new path is proven in Phase 4 unit tests).

**Scope discipline:** no Agent/Skill authoring, no Approval gate, no Memory tiers, no capture-pane fallback impl (regex fallback is explicitly out — hooks are primary; the task says regex is a soft fallback for non-CC harnesses, deferred). Only the substrate + registry + state machine.

**Premise check (verified 2026-06-01):** no SQLite in repo today (greenfield table); `bun:sqlite` is built-in (no dep); tmux 3.6a + `vc` v0.2.2 present; CC hook contracts confirmed from official docs (SessionStart/Stop/SessionEnd/StopFailure + common `session_id` field + HTTP hook type); `spawnTurn`/`runTurn`/`drain`/`killProcessTree`/`makeApp(vault)`/`listSessions(vault)` signatures read from source.

**Open discovery items folded into tasks (not blockers):** (a) exact settings-flag to scope hooks to one Run — Task 5 note + Task 12 Step 2 with a project-`settings.json` fallback; (b) dogfood tmux version ≥3.2 for `-e` env — Task 3 note + Task 12 Step 1 with a `env K=V` command-prefix fallback. Both have concrete fallbacks; neither re-opens the settled design.
