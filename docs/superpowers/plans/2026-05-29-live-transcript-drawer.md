# Live Transcript Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible bottom drawer to the void-os session page that shows the running Claude Code session's conversation as plain text, refreshing every 2s while open.

**Architecture:** A new pure module `src/transcript.ts` parses the Claude Code JSONL transcript (`parseTranscript`), locates it by uuid via fs (`locateTranscript`), and renders an escaped HTML fragment (`renderTranscript`). A new `GET /s/:uuid/transcript` Hono route serves the fragment. `renderShell` in `src/render.ts` gains a bottom bar + panel + a small poll script; opening the drawer shrinks the iframe so it never occludes the skill UI.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-29-live-transcript-drawer-design.md`

---

## File Structure

- **Create** `src/transcript.ts` — `Turn` type, `parseTranscript`, `locateTranscript`, `renderTranscript`. One responsibility: turn a session uuid into a renderable transcript fragment. Pure parse + fs locate + escaped render, no Hono.
- **Modify** `src/render.ts` — export the existing `esc` helper (so `transcript.ts` can reuse it); add drawer markup + CSS + poll script to `renderShell`.
- **Modify** `src/server.ts` — register `GET /s/:uuid/transcript`.
- **Create** `tests/transcript.test.ts` — unit tests for parse + locate + render.
- **Create** `tests/fixtures/transcript-sample.jsonl` — small real-shaped fixture.
- **Modify** `tests/server.test.ts` — route integration tests.
- **Modify** `tests/render.test.ts` — assert drawer markup is present in `renderShell` output.

Type contract used across tasks (define once in Task 1, referenced verbatim later):

```ts
export interface Turn {
  role: "user" | "assistant";
  text: string;
}
```

---

### Task 1: `parseTranscript` — dumb JSONL → turns

**Files:**
- Create: `src/transcript.ts`
- Create: `tests/fixtures/transcript-sample.jsonl`
- Create: `tests/transcript.test.ts`

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/transcript-sample.jsonl` with exactly these 7 lines (the blank line between is intentional — there is no blank line; each line is one JSON object):

```
{"type":"user","message":{"role":"user","content":"/smoke-test hello"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Turn 1 done. body.html written."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file listing"}]}}
{"type":"mode","mode":"default"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"   "}]}}
not valid json at all
```

This exercises: string content (keep), text-block array (keep), tool_use-only array (skip), tool_result-only user (skip), non-user/assistant type (skip), whitespace-only text (skip), malformed line (skip).

- [ ] **Step 2: Write the failing test**

Create `tests/transcript.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../src/transcript.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "transcript-sample.jsonl"), "utf8");

test("parseTranscript keeps only user/assistant turns with non-empty text", () => {
  const turns = parseTranscript(fixture);
  expect(turns).toEqual([
    { role: "user", text: "/smoke-test hello" },
    { role: "assistant", text: "Turn 1 done. body.html written." },
  ]);
});

test("parseTranscript joins multiple text blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "alpha " },
      { type: "tool_use", name: "X" },
      { type: "text", text: "beta" },
    ] },
  });
  expect(parseTranscript(line)).toEqual([{ role: "assistant", text: "alpha beta" }]);
});

test("parseTranscript returns [] for empty input", () => {
  expect(parseTranscript("")).toEqual([]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts`
Expected: FAIL — `Cannot find module '../src/transcript.ts'`.

- [ ] **Step 4: Write minimal implementation**

Create `src/transcript.ts`:

```ts
// transcript.ts — locate + parse + render the Claude Code JSONL transcript for a session.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { esc } from "./render.ts";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Parse a Claude Code JSONL transcript into a flat list of user/assistant turns.
 * Deliberately dumb: per-line try/catch, text-only extraction, everything else skipped.
 */
export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== "user" && o?.type !== "assistant") continue;
    const content = o.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
    }
    text = text.trim();
    if (!text) continue;
    turns.push({ role: o.type, text });
  }
  return turns;
}
```

(`locateTranscript` and `renderTranscript` are added in Tasks 2 and 3. The `esc` import is wired in Task 3; if `bun test` complains about the unused import before then, it will not — Bun does not error on unused imports.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts tests/fixtures/transcript-sample.jsonl
git commit -m "feat(transcript): parseTranscript — dumb JSONL to user/assistant turns"
```

---

### Task 2: `locateTranscript` — find the JSONL by uuid via fs

**Files:**
- Modify: `src/transcript.ts`
- Modify: `tests/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/transcript.test.ts`:

```ts
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { locateTranscript } from "../src/transcript.ts";

test("locateTranscript finds <uuid>.jsonl in any project subdir", () => {
  const root = "/tmp/voidos-tx-locate";
  rmSync(root, { recursive: true, force: true });
  const uuid = "f7f5f7a4-e74e-4002-8283-9afa30dae25a";
  const sub = join(root, "-Users-admin-void-os");
  mkdirSync(sub, { recursive: true });
  const file = join(sub, `${uuid}.jsonl`);
  writeFileSync(file, "{}");
  expect(locateTranscript(uuid, root)).toBe(file);
});

test("locateTranscript returns null for unknown uuid", () => {
  const root = "/tmp/voidos-tx-locate";
  expect(locateTranscript("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", root)).toBeNull();
});

test("locateTranscript rejects a uuid failing the format guard (no fs/exec)", () => {
  expect(locateTranscript("../../etc/passwd", "/tmp/voidos-tx-locate")).toBeNull();
});

test("locateTranscript returns null when projects dir is missing", () => {
  expect(locateTranscript("f7f5f7a4-e74e-4002-8283-9afa30dae25a", "/tmp/does-not-exist-xyz")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts`
Expected: FAIL — `locateTranscript is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/transcript.ts` (after `parseTranscript`):

```ts
const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Locate a session's JSONL transcript by uuid. fs-only (no shell), uuid-guarded.
 * @param projectsDir defaults to ~/.claude/projects; injectable for tests.
 * @returns absolute path to the first matching <uuid>.jsonl, or null.
 */
export function locateTranscript(
  uuid: string,
  projectsDir: string = join(homedir(), ".claude", "projects"),
): string | null {
  if (!UUID_RE.test(uuid)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const sub of entries) {
    const p = join(projectsDir, sub, `${uuid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): locateTranscript — fs lookup by uuid with format guard"
```

---

### Task 3: export `esc` + `renderTranscript` — escaped HTML fragment

**Files:**
- Modify: `src/render.ts:8` (export the `esc` helper)
- Modify: `src/transcript.ts`
- Modify: `tests/transcript.test.ts`

- [ ] **Step 1: Export `esc` from render.ts**

In `src/render.ts`, change the helper declaration from:

```ts
const esc = (s: string): string =>
```

to:

```ts
export const esc = (s: string): string =>
```

(No other change to render.ts in this step. All existing internal `esc(...)` calls keep working.)

- [ ] **Step 2: Write the failing test**

Append to `tests/transcript.test.ts`:

```ts
import { renderTranscript } from "../src/transcript.ts";

test("renderTranscript labels roles and escapes text", () => {
  const html = renderTranscript([
    { role: "user", text: "/smoke <b>hi</b>" },
    { role: "assistant", text: "done & ok" },
  ]);
  expect(html).toContain('class="turn role-user"');
  expect(html).toContain("you:");
  expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");        // escaped, not raw tags
  expect(html).toContain('class="turn role-assistant"');
  expect(html).toContain("claude:");
  expect(html).toContain("done &amp; ok");
  expect(html).not.toContain("<b>hi</b>");
});

test("renderTranscript returns empty string for no turns", () => {
  expect(renderTranscript([])).toBe("");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts`
Expected: FAIL — `renderTranscript is not a function`.

- [ ] **Step 4: Write minimal implementation**

Add to `src/transcript.ts` (the `esc` import at the top was already written in Task 1):

```ts
/** Render turns as an escaped HTML fragment (no surrounding document). */
export function renderTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const label = t.role === "user" ? "you:" : "claude:";
      return `<div class="turn role-${t.role}"><span class="who">${label}</span>${esc(t.text)}</div>`;
    })
    .join("");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/hub/workspace/void-os && bun test tests/transcript.test.ts && bun test tests/render.test.ts`
Expected: PASS — transcript tests (9 total) pass AND render.test.ts still green (esc export did not break it).

- [ ] **Step 6: Commit**

```bash
git add src/render.ts src/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): renderTranscript escaped fragment; export esc"
```

---

### Task 4: `GET /s/:uuid/transcript` route

**Files:**
- Modify: `src/server.ts` (import + one route, registered near the other `/s/:uuid/*` routes)
- Modify: `tests/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/server.test.ts` (after the existing imports, add the transcript helpers; the file already imports `mkdirSync`/`writeFileSync` and `join`):

```ts
test("GET /s/:uuid/transcript renders escaped turns from the CC transcript", async () => {
  const { makeApp } = await import("../src/server.ts");
  const uuid = "11111111-2222-3333-4444-555555555555";
  // Seed a fake ~/.claude/projects under a temp HOME that locateTranscript will read.
  const home = "/tmp/voidos-tx-home";
  const proj = join(home, ".claude", "projects", "-some-vault");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${uuid}.jsonl`),
    `{"type":"user","message":{"role":"user","content":"/smoke-test go"}}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working <x>"}]}}\n`);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const app = makeApp(vault);
    const res = await app.request(`/s/${uuid}/transcript`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/smoke-test go");
    expect(body).toContain("working &lt;x&gt;");
  } finally {
    process.env.HOME = prevHome;
  }
});

test("GET /s/:uuid/transcript returns strictly empty body for unknown uuid", async () => {
  const { makeApp } = await import("../src/server.ts");
  const app = makeApp(vault);
  const res = await app.request("/s/99999999-8888-7777-6666-555555555555/transcript");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/hub/workspace/void-os && bun test tests/server.test.ts`
Expected: FAIL — `/transcript` returns 404 (route not registered), so the `status).toBe(200)` / body assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `src/server.ts`, add the import alongside the existing ones:

```ts
import { parseTranscript, locateTranscript, renderTranscript } from "./transcript.ts";
```

Then register the route immediately after the `GET /s/:uuid/body` route (so all `/s/:uuid/*` GETs sit together):

```ts
  // GET /s/:uuid/transcript — minimal escaped HTML fragment of the CC conversation.
  // Empty body when no transcript exists yet (run not started) or uuid is malformed.
  app.get("/s/:uuid/transcript", (c) => {
    const path = locateTranscript(c.req.param("uuid"));
    if (!path) return c.html("");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return c.html("");
    }
    return c.html(renderTranscript(parseTranscript(raw)));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/hub/workspace/void-os && bun test tests/server.test.ts`
Expected: PASS — new transcript route tests green, existing server tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): GET /s/:uuid/transcript route"
```

---

### Task 5: Drawer UI in `renderShell`

**Files:**
- Modify: `src/render.ts` (inside `renderShell`, lines ~234-291: CSS, markup, script)
- Modify: `tests/render.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/render.test.ts` (it already imports `renderShell`; if not, add `renderShell` to the existing `import { ... } from "../src/render.ts"`):

```ts
test("renderShell includes the collapsible transcript drawer wired to /transcript", () => {
  const html = renderShell("abc12345-0000-1111-2222-333344445555", "/Users/admin/void-os");
  expect(html).toContain('id="drawer-bar"');
  expect(html).toContain('id="drawer-panel"');
  expect(html).toContain("/s/abc12345-0000-1111-2222-333344445555/transcript");
  expect(html).toContain("drawer-open");               // shrink-iframe class toggled
  expect(html).toContain("setInterval");               // 2s poll present
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/hub/workspace/void-os && bun test tests/render.test.ts`
Expected: FAIL — none of the drawer strings are present yet.

- [ ] **Step 3: Add the drawer CSS**

In `src/render.ts`, inside the `renderShell` template `<style>` block, immediately after the existing line:

```ts
iframe{border:0;width:100%;height:calc(100vh - 36px);display:block}
```

add:

```ts
body.drawer-open iframe{height:calc(100vh - 36px - 40vh - 28px)}
#drawer-bar{position:fixed;left:0;right:0;bottom:0;height:28px;z-index:10;
  display:flex;align-items:center;padding:0 .75rem;cursor:pointer;user-select:none;
  font-size:11px;font-family:monospace;color:hsl(var(--muted-foreground));
  background:hsl(217.2 32.6% 8%);border-top:1px solid hsl(var(--border))}
#drawer-bar:hover{color:hsl(var(--foreground))}
body.drawer-open #drawer-bar{bottom:40vh}
#drawer-panel{position:fixed;left:0;right:0;bottom:0;height:40vh;z-index:9;display:none;
  overflow:auto;padding:.5rem .75rem;background:hsl(var(--background));
  border-top:1px solid hsl(var(--border));font-size:12px;line-height:1.5}
body.drawer-open #drawer-panel{display:block}
.turn{white-space:pre-wrap;word-break:break-word;padding:.35rem 0;
  border-bottom:1px solid hsl(var(--border))}
.turn .who{display:block;font-family:monospace;font-size:10px;text-transform:uppercase;
  letter-spacing:.04em;color:hsl(var(--muted-foreground));margin-bottom:.15rem}
.role-user .who{color:hsl(217 70% 65%)}
.role-assistant .who{color:hsl(142 60% 60%)}
```

- [ ] **Step 4: Add the drawer markup**

In `src/render.ts`, immediately after the existing iframe line in `renderShell`:

```ts
<iframe id="f" src="/s/${esc(uuid)}/body"></iframe>
```

add:

```ts
<div id="drawer-panel"></div>
<div id="drawer-bar">▾ transcript</div>
```

- [ ] **Step 5: Add the drawer script**

In `src/render.ts`, inside the existing `<script>` block in `renderShell`, immediately before the closing `</script>` (after the existing `es.onmessage=...` line), add:

```ts
var dvBar=document.getElementById("drawer-bar");
var dvPanel=document.getElementById("drawer-panel");
var dvTimer=null;
function dvNearBottom(){return dvPanel.scrollTop+dvPanel.clientHeight>=dvPanel.scrollHeight-40;}
function dvRefresh(){
  fetch("/s/${esc(uuid)}/transcript").then(function(r){return r.text();}).then(function(html){
    var atBottom=dvNearBottom();
    dvPanel.innerHTML=html;
    if(atBottom){dvPanel.scrollTop=dvPanel.scrollHeight;}
  });
}
dvBar.addEventListener("click",function(){
  var open=document.body.classList.toggle("drawer-open");
  dvBar.textContent=open?"▴ transcript":"▾ transcript";
  if(open){dvRefresh();dvTimer=setInterval(dvRefresh,2000);}
  else if(dvTimer){clearInterval(dvTimer);dvTimer=null;}
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ~/hub/workspace/void-os && bun test tests/render.test.ts`
Expected: PASS.

- [ ] **Step 7: Full typecheck + suite**

Run: `cd ~/hub/workspace/void-os && bunx tsc --noEmit && bun test`
Expected: tsc exit 0; all tests pass (existing + the new transcript/server/render tests).

- [ ] **Step 8: Commit**

```bash
git add src/render.ts tests/render.test.ts
git commit -m "feat(render): collapsible live transcript drawer in session shell"
```

---

### Task 6: E2E verification (master-run, per project standard)

**Not a code task** — the master runs this personally; subagents do not have a reliable browser. No commit.

- [ ] **Step 1: Serve a fresh vault**

```bash
VOID_OS_VAULT=~/void-os-tx-e2e void-os init ~/void-os-tx-e2e   # if not already onboarded, onboard with smoke-test
VOID_OS_VAULT=~/void-os-tx-e2e void-os serve                   # or reuse the running :4317 server on ~/void-os
```

- [ ] **Step 2: Launch + open the drawer**

- Launch the `smoke-test` skill.
- On the session page, click the `▾ transcript` bar.
- Confirm: the panel expands, the iframe shrinks (skill form stays visible/clickable), and the feed shows the `you: /smoke-test …` launch prompt plus at least one `claude:` turn.

- [ ] **Step 3: Confirm it grows across a resume**

- Submit the smoke-test form (the `echo` field).
- Confirm the feed gains the resume turn(s) within ~2s and auto-scrolls to bottom.
- Scroll up mid-run; confirm a refresh does NOT yank you back to the bottom (scroll-position preserved).

- [ ] **Step 4: Confirm graceful-empty**

- Open the drawer on a brand-new session before its transcript exists; confirm an empty panel (no error banner), and that it populates once the run starts.

---

## Notes for the implementer

- No new dependencies. `homedir()` from `node:os` reads `$HOME` on macOS/Linux — that is why the server test overrides `process.env.HOME`.
- `src/transcript.ts` imports `esc` from `src/render.ts`; `render.ts` does **not** import `transcript.ts`, so there is no import cycle.
- Keep the parse dumb: do not add markdown, tool-call rendering, or timestamps — they are explicitly out of scope (see spec Scope guard).
- The drawer must not change `body.html` rendering or the existing EventSource reload behavior; it is additive markup + script in the shell only.
