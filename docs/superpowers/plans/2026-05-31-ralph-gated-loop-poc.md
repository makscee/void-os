# Ralph Gated-Loop PoC Implementation Plan

**Goal:** A single autonomous Issue-drain loop over the void-os web dashboard — a `ralph` SKILL (fixed Inputs/Process/Outputs prompt) + a server-side drain runner that re-spawns fresh sessions per box, runs each box's `auto`/`human` gate, and drains one real GitHub Issue end-to-end in a worktree.

**Architecture:** GitHub Issue = work store; a `- [ ]` checkbox in the Issue body = a box (story) carrying acceptance criteria + a gate annotation (`auto: <cmd>` | `human`) + priority. A new `src/drain.ts` runner is an `async for`-loop: each iteration spawns a FRESH `vc` session (own uuid, `--session-id`) whose cwd is the worktree, feeds it the ralph SKILL prompt + the Issue's open boxes + `progress.txt`, waits for `proc.exited`, then reads the session's structured outcome. Auto gates run a shell check with bounded inline recovery; human gates park the drain and surface the artifact in the dashboard agent-inbox, resumed via the existing `POST /s/:uuid/send`. No bespoke prd.json, no MCP server, no paused/interrupt-resume sessions.

**Tech Stack:** Bun + TypeScript, Hono (existing server), `bun test`, `bunx tsc --noEmit`, Playwright (existing e2e harness), `gh` CLI (authenticated, `repo` scope on `makscee/void-os`), git worktrees at `~/void-os-wt/<issue>/`.

---

## Load-bearing facts (verified against repo at plan time — do NOT re-derive)

- **Session model:** `~/.void-os/sessions/<uuid>/` holds `body.html`, `error.txt`, `run-N.log`, `session-meta.json`. Vault root = `process.env.VOID_OS_VAULT ?? ~/.void-os` (`src/paths.ts:vaultRoot`).
- **`spawnTurn(vault, uuid, argv, command)`** in `src/spawn.ts` is `void` / fire-and-forget — it does NOT return the process and does NOT await. It hardcodes `cwd: vault`. **The drain runner CANNOT reuse `spawnTurn`** — it needs its own awaitable spawn (factored out of the same primitives). `Bun.spawn(...).exited` is a promise — await it.
- **argv builders** (`src/spawn.ts`): `buildLaunchArgv(uuid, skill, text)` → `["--session-id", uuid, "-p", "/<skill> <text>", "--permission-mode", "bypassPermissions"]`. `buildAnswerArgv(uuid, text)` → `["--resume", uuid, "-p", "<preamble>\n<text>", ...PERM]`. `tokenizeCommand(cmd)` splits a runner prefix like `"vc --"`.
- **Runner command** resolved from `void-os.json` via `resolveRunner(readConfig(vault), label?)`; default `"vc --"`.
- **`POST /launch`** (`src/server.ts`): relay-auth guard → `randomUUID()` → mkdir session dir → write `session-meta.json` `{skill, launchedAt, text, runner}` → write placeholder `body.html` → `spawnTurn(...)` → redirect `/s/:uuid`.
- **`POST /s/:uuid/send`** (`src/server.ts`): serializes ALL form fields as `key: value\n`, recovers runner from `session-meta.json`, `spawnTurn(vault, uuid, buildAnswerArgv(uuid, text), runner)`, returns `workingPage(fields)`. **This is the human-gate verdict path — reuse it, do not build a new endpoint.**
- **Dashboard** (`renderDashboard` in `src/render.ts`, `listSessions` in `src/sessions.ts`): session status derived purely from filesystem — `error.txt`→`error`; `body.html` contains `<form`→`awaiting`; else `complete`.
- **`gh`** authenticated as `makscee`, `repo` scope, remote `makscee/void-os`, ZERO open issues (clean slate for the dogfood Issue).
- **Tests:** `package.json` scripts are only `test` (`bun test`) + `serve`. `bunx tsc --noEmit` exits 0 today. e2e files are plain `.ts` driver scripts in `tests/` (e.g. `tests/e2e-transcript-drawer.ts`), run with `bun tests/<file>.ts`, NOT `@playwright/test` runner. Unit tests are `tests/*.test.ts`.
- **void-os E2E traps** ([[feedback_void_os_e2e_gotchas]]): no shared helpers, maya script pinning, `isEmpty` session filter, `Bun.serve` idleTimeout. Watch these in any e2e step.
- **Relay cache_control:** the `vc` relay must pass `cache_control` through untouched ([[feedback_relay_header_merge_not_clobber]]). This PoC does not modify the relay; it only relies on the prefix-stable prompt being cacheable. T8 adds a verification step (Forge fix #5) capturing one outbound Anthropic call with `cache_control` present OR a cache-read usage hit — a VRL-30-class strip would functionally pass but blow ~10x token cost.
- **Machine-readable signal file (Forge fix #1):** there is NO existing signal/outcome file in the session dir today. `classifyOutcome` MUST read a dedicated `signal.txt` written by the agent — NOT `body.html`. Verified: `deriveStatus` (`src/sessions.ts:24`) keys session `awaiting` status off `body.html` containing `<form`. So body.html stays dashboard-presentation-only (and for human gates MUST still carry the `<form>` so the inbox shows `awaiting`), while the terminal machine signal lives in `signal.txt`. A new `signalPath(vault, uuid)` is added to `src/paths.ts`.
- **cwd/vault split is clean (Forge fix #2):** verified that `spawnTurn` hardcodes `cwd: vault` but ALL session state I/O (`runLogPath`, `errorPath`, `bodyPath`, and the new `signalPath`) resolves under `sessionDir(vault, uuid)` — fully decoupled from cwd. Therefore `runTurn(cwd, vault, uuid, …)` can run the agent in the worktree (code/git plane) while session state writes land under the vault (state plane) with no split-brain. T5 tests this divergence explicitly.
- **`gh` checkbox edit is full-body-replace only:** verified `gh issue edit` (gh 2.89.0) exposes only `--body`/`--body-file` (whole-body replacement); there is NO targeted task-list/checkbox API. This is why Forge fix #3 (re-fetch immediately before write + targeted single-line edit of the `- [ ]`→`- [x]` line, serialized through the runner) is mandatory — a naive full-body overwrite would clobber a concurrent operator reshape.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | add `verify` npm script (Task 1) |
| `scripts/verify.sh` (new) | the single scriptable green/red gate: `bun test` + `bunx tsc --noEmit` (Task 1) |
| `docs/ralph/issue-schema.md` (new) | canonical box/story schema doc — box = `- [ ]` + criteria + `auto:`/`human` gate + priority (Task 2) |
| `catalog/skills/ralph/SKILL.md` (new) | the fixed loop prompt as an explicit Inputs/Process/Outputs contract, self-documenting for a zero-context agent (Task 3) |
| `src/paths.ts` | add `signalPath(vault, uuid)` → `sessionDir/signal.txt` — the machine-readable terminal-signal carrier (Forge #1, Task 5) |
| `src/issue.ts` (new) | parse Issue body → `Box[]` (text, gate, priority, checked); `checkBox(body, box)` returns a body with ONLY that box's line flipped `- [ ]`→`- [x]` (targeted, Forge #3); detect all-checked (Task 4) |
| `src/drain.ts` (new) | the server-side drain runner: fresh-session loop, MAX backstop, auto-gate bounded recovery, `PROMISE COMPLETE HERE` early-exit, `NEEDS HUMAN` park; `classifyOutcome` reads `signal.txt` NOT body.html (Forge #1); idempotent re-run + safe close (Forge #4) (Task 5–7) |
| `src/spawn.ts` | factor an awaitable `runTurn(cwd, vault, uuid, argv, command)` used by the drain runner; explicit `cwd` parameter = worktree (code plane) while session state stays under `sessionDir(vault, …)` (state plane) (Forge #2, Task 5) |
| `src/server.ts` | wire a `POST /drain` launch route + agent-inbox surfacing of a parked human box (Task 6) |
| `src/render.ts` | agent-inbox panel: list drains parked on a human box with accept/edit/feedback form posting to `POST /s/:uuid/send` (Task 6) |
| `tests/issue.test.ts`, `tests/drain.test.ts` (new) | unit tests for box parsing + runner state machine (Tasks 4–5, 7) |
| `tests/e2e-ralph-drain.ts` (new) | optional e2e driving a fake-runner drain to green (Task 7) |

---

## Phase / shippability map

- **Phase 1 (Task 1)** — `verify` command. Shippable alone: a green/red script.
- **Phase 2 (Tasks 2–3)** — Issue/story schema doc + `ralph` SKILL.md. Shippable alone: a launchable skill + a documented schema; no runner yet.
- **Phase 3 (Tasks 4–6)** — `src/issue.ts` + `src/drain.ts` runner + server/inbox wiring. Shippable alone: drain runnable against a synthetic Issue with a fake runner; auto + human gates exercised by unit/integration tests.
- **Phase 4 (Tasks 7–8)** — author the FIRST real dogfood Issue + run the end-to-end drain in a worktree; capture evidence.

Phases are strictly sequential (Phase 4 needs all of 1–3). Within Phase 3, Tasks 4 → 5 → 6 are sequential (runner depends on issue parsing; server wiring depends on runner).

---

## Task 1: Single `verify` command

**Files:**
- Create: `scripts/verify.sh`
- Modify: `package.json` (scripts block)
- Test: manual run (this is the test harness itself)

- [ ] **Step 1: Write `scripts/verify.sh`**

```bash
#!/usr/bin/env bash
# verify.sh — the single scriptable green/red gate for void-os.
# Exit 0 = green (safe to check a box), non-zero = red.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== bunx tsc --noEmit =="
bunx tsc --noEmit
echo "== bun test =="
bun test
echo "VERIFY GREEN"
```

- [ ] **Step 2: Make it executable + add the npm script**

```bash
chmod +x scripts/verify.sh
```

In `package.json` `scripts`, add:

```json
"verify": "bash scripts/verify.sh"
```

(Keep existing `test` and `serve`.)

- [ ] **Step 3: Run it to confirm green on a clean tree**

Run: `bun run verify`
Expected: ends with `VERIFY GREEN`, exit 0.

- [ ] **Step 4: Confirm red is scriptable**

Confirm a failing `tsc`/test makes `bun run verify` exit non-zero without printing `VERIFY GREEN`.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.sh package.json
git commit -m "feat(verify): single scriptable green/red gate (bun test + tsc)"
```

---

## Task 2: Issue/story schema doc

**Files:**
- Create: `docs/ralph/issue-schema.md`

This doc is a **canonical source** — the SKILL.md and `src/issue.ts` parser both reference it; do not duplicate the grammar elsewhere.

- [ ] **Step 1: Write the schema doc**

Content (write verbatim, this IS the spec the parser implements):

````markdown
# Ralph Issue / Story Schema

A **drain unit** is one GitHub Issue. Its body is a task-list of **boxes**.
A drain loops over the open boxes until all are checked, then closes the Issue.
This file is the single canonical home for the box grammar — the `ralph` SKILL
and `src/issue.ts` both implement exactly this. Do not redefine it elsewhere.

## Box grammar

Each box is one GitHub task-list item:

```
- [ ] <title> {gate} {prio}
      <acceptance criteria — one or more indented lines>
```

- `- [ ]` unchecked / `- [x]` checked (durable `passes` state, owned by `gh`).
- `<title>` — short imperative summary of the story.
- `{gate}` — REQUIRED. Exactly one of:
  - `auto: <shell-check>` — a machine gate. `<shell-check>` is a command run
    from the worktree root; exit 0 = green. Usually `bun run verify` but may be
    a narrower check (e.g. `bun test tests/foo.test.ts`).
  - `human` — an async PR-review-as-gate. The agent produces an artifact (a diff /
    a rendered page) and emits `NEEDS HUMAN`; a human verdict resolves it.
- `{prio}` — REQUIRED. `p1` (highest) .. `pN`. The agent self-selects the
  highest-priority OPEN box each iteration.
- Acceptance criteria — indented lines under the box, plain prose; the agent
  treats them as the definition-of-done for that box.

## Annotation placement

Gate + priority live in a trailing brace group on the box title line, e.g.:

```
- [ ] Add /healthz route returning 200 {auto: bun run verify} {p1}
      Route GET /healthz returns HTTP 200 with body "ok".
- [ ] Polish the dashboard empty-state copy {human} {p3}
      Render an inviting empty-state; needs a human eye on tone.
```

## Drain lifecycle

1. Runner spawns a fresh session, feeds it open boxes + progress.txt.
2. Agent self-selects highest-priority open box, works ONLY that box.
3. Agent runs the box's gate (auto check, or produces artifact + NEEDS HUMAN).
4. On pass: agent checks the box (`gh`), appends progress.txt, commits.
5. All boxes checked → agent emits `PROMISE COMPLETE HERE`; runner closes the Issue.
````

- [ ] **Step 2: Commit**

```bash
git add docs/ralph/issue-schema.md
git commit -m "docs(ralph): canonical Issue/story box schema"
```

---

## Task 3: `ralph` SKILL.md (fixed loop prompt)

**Files:**
- Create: `catalog/skills/ralph/SKILL.md`

The SKILL must be discoverable by `listCatalogSkills` (needs `name` + `description` frontmatter) and self-documenting for a zero-prior-context agent — every iteration is a fresh session.

- [ ] **Step 1: Write the SKILL.md**

Write verbatim (frontmatter then body). The body is an explicit Inputs/Process/Outputs contract:

````markdown
---
name: ralph
description: One iteration of the gated Issue-drain loop. Picks the highest-priority open box, works only it, runs its gate, checks the box and commits — or emits NEEDS HUMAN / PROMISE COMPLETE HERE.
---

# ralph — one drain iteration

You are a FRESH void-os session with NO memory of prior iterations. Everything you
need is in your Inputs below. You will work exactly ONE box this iteration, then stop.
Do NOT attempt the whole Issue. The runner re-spawns a fresh you for the next box.

## Inputs (read selectively — token-budgeted, ~2–8k; do NOT read whole files)

- **The Issue** — open boxes are listed in your launch prompt. Schema:
  `docs/ralph/issue-schema.md` (read only the grammar section if unsure).
- **`progress.txt`** — append-only scratch memory in your cwd (the worktree). Read it
  to learn what prior iterations did / what failed. May be empty on iteration 1.
- **`git log --oneline -10`** — recent commits, your durable history.
- **Stable references** — `CONTEXT.md`, repo standards, the `verify` spec. Read only
  the relevant SECTION for the box you select, not whole files.

## Process

1. **Select** the highest-priority (`p1` first) OPEN box from the Issue. Work ONLY it.
2. **Work** the box: make the minimal code/doc change its acceptance criteria require.
   Render your progress to this session's `body.html` (resolve `$VOID_OS_SESSION`, write
   `sessions/<id>/body.html`) so the dashboard shows what you are doing.
3. **Run the gate** named in the box's `{...}` annotation:
   - **`auto: <check>`** — run `<check>` from the worktree root.
     - **Green (exit 0):** go to step 4.
     - **Red:** read the failure output, fix the cause, re-run. Retry inline up to
       **3 times total**. Still red after 3 → append a `FAILED: <box> — <last error>`
       line to `progress.txt`, render the failure to `body.html`, write `FAILED` to
       `signal.txt` (see Signal contract below), and STOP (do NOT check the box). The
       next fresh session will retry.
   - **`human`** — produce the artifact (a committed branch / a rendered preview in
     `body.html`), append a `NEEDS HUMAN: <box> — <what to review>` line to
     `progress.txt`, render the artifact + a review summary + an accept/edit/feedback
     `<form>` posting to `/s/$VOID_OS_SESSION/send` into `body.html` (the `<form>` is
     what makes the dashboard mark you `awaiting`), write `NEEDS HUMAN` to `signal.txt`,
     and STOP. Do NOT check the box.
4. **On pass** (auto green, OR you were resumed with a human ACCEPT verdict):
   - Check the box with a TARGETED, lost-update-safe edit: (a) RE-FETCH the current body
     immediately first — `gh issue view <num> --json body -q .body` (an operator reshape
     may have changed it since launch); (b) flip ONLY your box's `- [ ]` line to `- [x]`
     (do NOT regenerate or overwrite the whole body from your stale launch copy);
     (c) write it back — `gh issue edit <num> --body-file -`. `gh` has no targeted
     checkbox API; the targeted single-line flip on a freshly-fetched body is how we
     avoid clobbering concurrent operator edits.
   - Append a `DONE: <box>` line to `progress.txt`.
   - `git add -A && git commit -m "<box title>"` — code + progress.txt together.
   - Write `PROGRESS` to `signal.txt` (a normal box was checked; the runner loops).
5. **If, after checking your box, ALL boxes are now checked** (verify against the body you
   just wrote back): render a done summary to `body.html` and write `PROMISE COMPLETE HERE`
   to `signal.txt`.

## Signal contract (machine-readable — Forge fix #1)

`body.html` is dashboard-presentation HTML and is NOT a reliable sentinel carrier. Every
iteration you MUST write your ONE terminal signal to a dedicated file the runner reads:

- Path: `$VOID_OS_VAULT/sessions/$VOID_OS_SESSION/signal.txt` (resolve both env vars;
  `VOID_OS_VAULT` defaults to `~/.void-os` if unset). This is the SAME session dir your
  `body.html` lives in — it is under the VAULT, not your cwd/worktree.
- Write EXACTLY one of these literal first lines: `PROMISE COMPLETE HERE` | `NEEDS HUMAN` |
  `FAILED` | `PROGRESS`. Overwrite (not append) — it reflects only this iteration.
- The runner reads `signal.txt` to decide done / park / loop. Do NOT rely on tokens in
  `body.html` for control flow — body.html is for the human, signal.txt is for the runner.

## Resume-after-human-verdict

If your launch prompt contains a human verdict (`verdict: accept` / `verdict: edit` /
`feedback: <text>`), you were resumed to act on it:
- `accept` → treat the human box as passed; do step 4 (check box + commit).
- `edit` / `feedback` → the feedback may RESHAPE the Issue's boxes (add/remove/rewrite
  boxes via `gh issue edit`), not just revise one diff. Apply it, then STOP for the next
  iteration (do NOT also check a box this turn unless the feedback was a plain accept).

## Outputs (contract)

- `body.html` rewritten every turn (render contract — the dashboard reads it). For a human
  gate it MUST contain the accept/edit/feedback `<form>` (this is what marks you `awaiting`).
- `signal.txt` written every turn with EXACTLY one terminal signal (see Signal contract):
  - `PROGRESS` — a checked box + commit (runner loops), OR
  - `NEEDS HUMAN` — parked on a human gate, OR
  - `PROMISE COMPLETE HERE` — all boxes done, OR
  - `FAILED` — auto gate exhausted after 3 inline retries (box left unchecked).
- NEVER carry state in the terminal conversation — only files (Issue, progress.txt, git,
  signal.txt).
````

- [ ] **Step 2: Confirm the skill is discoverable**

Run: `bun -e 'import {listCatalogSkills} from "./src/catalog.ts"; console.log(listCatalogSkills("./catalog").map(s=>s.name))'`
Expected: array includes `"ralph"`.

- [ ] **Step 3: Add a catalog test asserting ralph parses**

In `tests/catalog.test.ts` (existing), add a case asserting `listCatalogSkills` returns a skill named `ralph` with a non-empty description. (Match the existing test style in that file.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/skills/ralph/SKILL.md tests/catalog.test.ts
git commit -m "feat(ralph): drain-loop SKILL.md as Inputs/Process/Outputs contract"
```

---

## Task 4: `src/issue.ts` — box parser

**Files:**
- Create: `src/issue.ts`
- Test: `tests/issue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/issue.test.ts
import { test, expect } from "bun:test";
import { parseBoxes, allChecked, checkBox, type Box } from "../src/issue.ts";

const BODY = `Some preamble.

- [ ] Add /healthz route {auto: bun run verify} {p1}
      Route GET /healthz returns 200.
- [x] Scaffold module {auto: bun test} {p2}
- [ ] Polish empty-state copy {human} {p3}
      Needs a human eye on tone.
`;

test("parseBoxes extracts gate, priority, checked", () => {
  const boxes = parseBoxes(BODY);
  expect(boxes.length).toBe(3);
  expect(boxes[0]).toMatchObject({ checked: false, gate: { kind: "auto", check: "bun run verify" }, prio: 1, title: "Add /healthz route" });
  expect(boxes[1]).toMatchObject({ checked: true, prio: 2 });
  expect(boxes[2]).toMatchObject({ gate: { kind: "human" }, prio: 3 });
});

test("allChecked false when an open box remains, true when all checked", () => {
  expect(allChecked(parseBoxes(BODY))).toBe(false);
  const done = BODY.replace(/- \[ \]/g, "- [x]");
  expect(allChecked(parseBoxes(done))).toBe(true);
});

// Forge fix #3: checkBox flips ONLY the target box's line, leaving the rest of the
// body byte-for-byte intact — so a concurrent operator reshape is not clobbered.
test("checkBox flips only the target box line, preserves everything else", () => {
  const boxes = parseBoxes(BODY);
  const out = checkBox(BODY, boxes[0]); // the open /healthz box
  expect(out).toContain("- [x] Add /healthz route {auto: bun run verify} {p1}");
  // the other lines are untouched (including the operator's prose + already-checked box)
  expect(out).toContain("Some preamble.");
  expect(out).toContain("- [x] Scaffold module {auto: bun test} {p2}");
  expect(out).toContain("- [ ] Polish empty-state copy {human} {p3}");
  // exactly one line changed
  expect(out.split("\n").filter((l, idx) => l !== BODY.split("\n")[idx]).length).toBe(1);
});

test("checkBox is idempotent on an already-checked box", () => {
  const boxes = parseBoxes(BODY);
  expect(checkBox(BODY, boxes[1])).toBe(BODY); // box[1] already - [x]
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/issue.test.ts`
Expected: FAIL — `parseBoxes` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/issue.ts — parse a GitHub Issue body into boxes (stories). Schema: docs/ralph/issue-schema.md
export type Gate = { kind: "auto"; check: string } | { kind: "human" };
export interface Box {
  title: string;
  checked: boolean;
  gate: Gate;
  prio: number;
  raw: string; // the full "- [ ] ..." line, for re-writing the body
}

const BOX_RE = /^- \[( |x)\] (.+)$/;

/** Parse a brace group like "{auto: bun run verify} {p1}" off a title; return {title, gate, prio}. */
function parseAnnotations(line: string): { title: string; gate: Gate; prio: number } {
  const braces = [...line.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim());
  let gate: Gate | undefined;
  let prio = 999;
  for (const b of braces) {
    if (b.startsWith("auto:")) gate = { kind: "auto", check: b.slice(5).trim() };
    else if (b === "human") gate = { kind: "human" };
    else if (/^p\d+$/.test(b)) prio = parseInt(b.slice(1), 10);
  }
  if (!gate) throw new Error(`box missing gate annotation: ${line}`);
  const title = line.replace(/\s*\{[^}]*\}/g, "").trim();
  return { title, gate, prio };
}

export function parseBoxes(body: string): Box[] {
  const boxes: Box[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(BOX_RE);
    if (!m) continue;
    const checked = m[1] === "x";
    const { title, gate, prio } = parseAnnotations(m[2]);
    boxes.push({ title, checked, gate, prio, raw: line });
  }
  return boxes;
}

export function allChecked(boxes: Box[]): boolean {
  return boxes.length > 0 && boxes.every((b) => b.checked);
}

/**
 * Forge fix #3: lost-update-safe checkbox flip. Given a freshly-fetched body and the
 * target box, return a new body with ONLY that box's `- [ ]` line changed to `- [x]`,
 * matched by the box's exact `raw` line. Every other byte (operator prose, other boxes,
 * reshaped content) is preserved. Idempotent if the box is already checked.
 * The CALLER must pass a body it re-fetched immediately before calling this — never a
 * stale launch-time copy — and must serialize writes (see drain runner).
 */
export function checkBox(body: string, box: Box): string {
  if (box.checked) return body;
  const checkedLine = box.raw.replace(/^- \[ \]/, "- [x]");
  // Replace the first exact occurrence of the raw line only.
  const idx = body.indexOf(box.raw);
  if (idx === -1) return body; // box not found in current body (reshaped away) — no-op
  return body.slice(0, idx) + checkedLine + body.slice(idx + box.raw.length);
}

/** Highest-priority OPEN box (lowest prio number), or undefined if none open. */
export function nextOpenBox(boxes: Box[]): Box | undefined {
  return boxes.filter((b) => !b.checked).sort((a, b) => a.prio - b.prio)[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/issue.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/issue.ts tests/issue.test.ts
git commit -m "feat(issue): parse boxes + lost-update-safe targeted checkBox"
```

---

## Task 5: `src/drain.ts` runner + awaitable spawn

**Files:**
- Modify: `src/spawn.ts` (factor an awaitable spawn with `cwd`)
- Create: `src/drain.ts`
- Test: `tests/drain.test.ts`

The runner is a `for`-loop with a MANDATORY MAX backstop. It does NOT assign boxes (the agent self-selects). Each iteration: build the launch prompt (open boxes + progress.txt), spawn a fresh session **in the worktree (cwd=worktree)** while its state writes land **under the vault** (`sessionDir(vault, uuid)`), await exit, then inspect the session's **`signal.txt`** (NOT body.html) for the terminal signal (`PROMISE COMPLETE HERE` → done; `NEEDS HUMAN` → park; `FAILED`/`PROGRESS` → loop).

**Forge fix #2 — the cwd/vault split is the runner's core invariant.** The agent's cwd is the worktree (so its `git commit` lands on `ralph/issue-<N>` and `bun run verify` runs against worktree code), but `runTurn` resolves ALL session I/O (`runLogPath`/`errorPath`/`bodyPath`/`signalPath`) under the vault via `sessionDir(vault, uuid)` — these are decoupled (verified: `spawnTurn` already hardcodes `cwd: vault` yet writes state via `sessionDir`). This is why `runTurn` takes `cwd` AND `vault` as separate args. The human-gate resume (`POST /s/:uuid/send` → `spawnTurn`, which uses `cwd: vault`) and the drain spawn (`cwd: worktree`) BOTH write to the same `sessionDir(vault, uuid)`, so resume-after-human-gate reads/writes the same state with no split-brain.

- [ ] **Step 1: Add `signalPath` to `src/paths.ts`**

```typescript
export const signalPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "signal.txt");
```

- [ ] **Step 2: Factor an awaitable spawn in `src/spawn.ts`**

Add (do not break existing `spawnTurn` — refactor it to delegate):

```typescript
/**
 * Awaitable spawn of one runner turn. Returns the exit code.
 * Unlike spawnTurn (fire-and-forget, cwd=vault), this lets the drain runner
 * await each iteration and run it in an arbitrary cwd (the worktree).
 * @param cwd - working dir for the spawned vc (the worktree for drains).
 */
export async function runTurn(
  cwd: string,
  vault: string,
  uuid: string,
  argv: string[],
  command: string,
): Promise<number> {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const proc = Bun.spawn([...tokenizeCommand(command), ...argv], {
    cwd,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  const watchdog = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(watchdog);
  return code ?? -1;
}
```

(Leave `spawnTurn` as-is for the dashboard launch/answer paths — it has its own error.txt/mtime logic that the drain runner does not need.)

- [ ] **Step 3: Write the failing test for the runner state machine (signal.txt, NOT body.html)**

```typescript
// tests/drain.test.ts
import { test, expect } from "bun:test";
import { classifyOutcome, type Outcome } from "../src/drain.ts";

// Forge fix #1: classifyOutcome reads the machine-readable signal.txt content,
// NOT free-form body.html. The first line is the terminal signal.
test("classifyOutcome maps signal.txt content to outcome", () => {
  expect(classifyOutcome("PROMISE COMPLETE HERE")).toBe("complete");
  expect(classifyOutcome("NEEDS HUMAN")).toBe("human");
  expect(classifyOutcome("PROGRESS")).toBe("progress");
  expect(classifyOutcome("FAILED")).toBe("progress"); // failure recorded; runner loops
  expect(classifyOutcome("")).toBe("error");           // no signal written = agent crashed
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/drain.test.ts`
Expected: FAIL — `classifyOutcome` not defined.

- [ ] **Step 5: Write `src/drain.ts`**

```typescript
// src/drain.ts — server-side Issue-drain runner. One fresh session per box.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionDir, signalPath } from "./paths.ts";
import { runTurn } from "./spawn.ts";
import { parseBoxes, nextOpenBox, allChecked } from "./issue.ts";

export type Outcome = "complete" | "human" | "progress" | "error";

/**
 * Forge fix #1: classify the terminal signal from signal.txt content (NOT body.html).
 * The first line is the signal. Empty/missing = the agent crashed without signalling.
 */
export function classifyOutcome(signal: string): Outcome {
  const first = signal.split("\n")[0]?.trim() ?? "";
  if (first === "PROMISE COMPLETE HERE") return "complete";
  if (first === "NEEDS HUMAN") return "human";
  if (first === "PROGRESS" || first === "FAILED") return "progress";
  return "error";
}

export interface DrainOpts {
  vault: string;
  worktree: string;     // ~/void-os-wt/<issue>/
  issueNum: number;
  runner: string;       // "vc --"
  max: number;          // MANDATORY backstop
  fetchBody: () => Promise<string>;   // gh issue view --json body -q .body (always re-fetch)
  closeIssue?: () => Promise<void>;   // gh issue close — called ONLY when allChecked(refetched)
}

export interface DrainResult {
  status: "complete" | "parked-human" | "max-reached" | "stalled" | "error";
  parkedUuid?: string;  // session awaiting a human verdict
  iterations: number;
}

/** Build the launch prompt text: open boxes + progress.txt tail. */
export function buildDrainPrompt(issueNum: number, body: string, progress: string): string {
  const open = parseBoxes(body).filter((b) => !b.checked);
  const list = open.map((b) => `${b.raw}`).join("\n");
  return [
    `Issue #${issueNum}. Open boxes:`,
    list,
    `--- progress.txt ---`,
    progress || "(empty)",
  ].join("\n");
}

/**
 * Forge fix #4: idempotent drain + safe close.
 * - Re-fetch the body EVERY iteration (the agent or operator may have changed it) and
 *   recompute open boxes from the fresh body — already-checked boxes are skipped, so a
 *   crash/MAX-trip re-run resumes cleanly.
 * - progress.txt is deleted ONLY after allChecked is confirmed (Ralph-faithful end).
 * - The Issue is closed ONLY when allChecked(refetched body) is true.
 */
export async function drain(opts: DrainOpts): Promise<DrainResult> {
  const progressPath = join(opts.worktree, "progress.txt");
  if (!existsSync(progressPath)) writeFileSync(progressPath, "");

  for (let i = 1; i <= opts.max; i++) {
    const body = await opts.fetchBody();               // re-fetch each iter (idempotent)
    const boxes = parseBoxes(body);
    if (allChecked(boxes)) return await finishComplete(i - 1);
    if (!nextOpenBox(boxes)) return { status: "stalled", iterations: i - 1 };

    const uuid = randomUUID();
    const dir = sessionDir(opts.vault, uuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session-meta.json"),
      JSON.stringify({ skill: "ralph", launchedAt: Date.now(), text: `drain #${opts.issueNum}`, runner: opts.runner, drainIssue: opts.issueNum }),
    );
    const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "";
    const prompt = buildDrainPrompt(opts.issueNum, body, progress);
    // Fresh ralph session: cwd = worktree (code plane); state writes land under vault (state plane).
    const argv = ["--session-id", uuid, "-p", `/ralph ${prompt}`, "--permission-mode", "bypassPermissions"];
    await runTurn(opts.worktree, opts.vault, uuid, argv, opts.runner);

    // Forge fix #1: read the MACHINE signal file, not body.html.
    const sp = signalPath(opts.vault, uuid);
    const signal = existsSync(sp) ? readFileSync(sp, "utf8") : "";
    const outcome = classifyOutcome(signal);
    if (outcome === "complete") return await finishComplete(i);
    if (outcome === "human") return { status: "parked-human", parkedUuid: uuid, iterations: i };
    if (outcome === "error") return { status: "error", iterations: i }; // agent crashed, no signal
    // "progress" → loop; the agent already checked a box or recorded a FAILED line
  }
  return { status: "max-reached", iterations: opts.max };

  // Safe close: confirm against a FRESH fetch before close + progress delete (Forge #4).
  async function finishComplete(iterations: number): Promise<DrainResult> {
    const fresh = parseBoxes(await opts.fetchBody());
    if (allChecked(fresh)) {
      await opts.closeIssue?.();
      if (existsSync(progressPath)) rmSync(progressPath);
      return { status: "complete", iterations };
    }
    return { status: "stalled", iterations }; // a box re-opened mid-flight; do not close
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/drain.test.ts`
Expected: PASS.

- [ ] **Step 7: Add an integration test driving the loop with a FAKE runner (writes signal.txt + commits in cwd)**

Inject a fake by pointing `runner` at a small bun script under `tests/fixtures/` that, on each spawn, writes its terminal signal to `signal.txt` under the VAULT session dir (Forge #1) AND makes a real `git commit` in its CWD (so the cwd/vault split is exercised — Forge #2). Write that fixture:

```typescript
// tests/fixtures/fake-ralph.ts — pretends to be vc.
// Forge #1: writes the terminal signal to signal.txt (under the VAULT), NOT body.html.
// Forge #2: makes a real commit in CWD (the worktree) to prove cwd != vault state plane.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const uuid = process.env.VOID_OS_SESSION!;
const vault = process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");
const dir = join(vault, "sessions", uuid);
mkdirSync(dir, { recursive: true });
// dashboard-presentation only:
writeFileSync(join(dir, "body.html"), "<h1>fake drain</h1>");
// machine signal the runner actually reads:
writeFileSync(join(dir, "signal.txt"), "PROMISE COMPLETE HERE\n");
// prove the commit lands in CWD (the worktree), not the vault:
writeFileSync(join(process.cwd(), "fake-touch.txt"), uuid);
spawnSync("git", ["add", "-A"], { cwd: process.cwd() });
spawnSync("git", ["commit", "-m", `fake box ${uuid}`], { cwd: process.cwd() });
```

Integration test — `fetchBody` flips the box to checked after the first call:

```typescript
test("drain ends complete when a fresh session writes PROMISE COMPLETE HERE to signal.txt", async () => {
  const tmp = `/tmp/ralph-drain-${Date.now()}`;
  let calls = 0;
  const result = await drain({
    vault: tmp,
    worktree: tmp,
    issueNum: 1,
    runner: `bun ${import.meta.dir}/fixtures/fake-ralph.ts --`,
    max: 5,
    fetchBody: async () => (calls++ === 0
      ? "- [ ] do it {auto: true} {p1}"
      : "- [x] do it {auto: true} {p1}"),
    closeIssue: async () => {},
  });
  expect(result.status).toBe("complete");
  expect(result.iterations).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 8: Add the cwd≠vault split test (Forge fix #2)**

Make `worktree` a real, separate git repo and assert BOTH planes after one turn: the commit landed in the WORKTREE (code plane) and `signal.txt` is readable under the VAULT (state plane). Use distinct tmp dirs for `vault` and `worktree`.

```typescript
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { signalPath } from "../src/paths.ts";

test("drain runs the agent in the worktree (commit lands there) while state writes to the vault", async () => {
  const vault = `/tmp/ralph-vault-${Date.now()}`;
  const worktree = `/tmp/ralph-wt-${Date.now()}`;
  mkdirSync(worktree, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: worktree });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: worktree });
  const before = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: worktree }).stdout.toString().trim();

  let calls = 0;
  const res = await drain({
    vault, worktree, issueNum: 7,
    runner: `bun ${import.meta.dir}/fixtures/fake-ralph.ts --`,
    max: 3,
    fetchBody: async () => (calls++ === 0
      ? "- [ ] split test {auto: true} {p1}"
      : "- [x] split test {auto: true} {p1}"),
    closeIssue: async () => {},
  });

  expect(res.status).toBe("complete");
  // code plane: commit landed in the worktree, NOT the vault
  const after = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: worktree }).stdout.toString().trim();
  expect(Number(after)).toBeGreaterThan(Number(before));
  expect(existsSync(join(vault, ".git"))).toBe(false);
  // state plane: the session's signal.txt is readable under the vault
  // (uuid is random; assert at least one session dir carries the signal)
  const fs = await import("node:fs");
  const sessRoot = join(vault, "sessions");
  const uuids = existsSync(sessRoot) ? fs.readdirSync(sessRoot) : [];
  expect(uuids.length).toBeGreaterThan(0);
  expect(readFileSync(signalPath(vault, uuids[0]), "utf8")).toContain("PROMISE COMPLETE HERE");
});
```

- [ ] **Step 9: Run tests**

Run: `bun test tests/drain.test.ts`
Expected: PASS (classifyOutcome + integration + cwd/vault split).

- [ ] **Step 10: Commit**

```bash
git add src/paths.ts src/spawn.ts src/drain.ts tests/drain.test.ts tests/fixtures/fake-ralph.ts
git commit -m "feat(drain): fresh-session runner — signal.txt control, cwd/vault split, idempotent safe-close"
```

---

## Task 6: Server `POST /drain` route + agent-inbox surfacing

**Files:**
- Modify: `src/server.ts` (add `POST /drain`; surface parked human boxes)
- Modify: `src/render.ts` (agent-inbox panel on the dashboard)
- Test: `tests/server.test.ts` (existing)

The human-gate verdict path REUSES `POST /s/:uuid/send` — the parked session's uuid is a normal session; the operator's accept/edit/feedback form posts there and resumes `vc` via `buildAnswerArgv`. The drain runner, when it returns `parked-human`, leaves the session in `awaiting` state (its `body.html` contains `<form>` posting to `/s/<uuid>/send` plus the `NEEDS HUMAN` token), so `listSessions` already shows it as `awaiting`. The agent-inbox panel is a filtered view of awaiting drain sessions.

- [ ] **Step 1: Add a `POST /drain` route**

In `src/server.ts`, after the `/launch` route, add a route that kicks off a drain in the background. The drain itself runs long; fire it without awaiting (like `spawnTurn`) and redirect to the dashboard. The route resolves the worktree path from the issue number (`~/void-os-wt/issue-<num>/`) — for the PoC the worktree is created manually by the implementer before pressing the button; the route asserts it exists.

```typescript
import { drain } from "./drain.ts";
import { homedir } from "node:os";

// POST /drain — kick off an Issue-drain in a pre-created worktree. Fire-and-forget.
app.post("/drain", async (c) => {
  const body = await c.req.parseBody();
  const issueNum = parseInt(String(body.issue ?? ""), 10);
  if (!Number.isFinite(issueNum)) return c.text("bad issue number", 400);
  const worktree = join(homedir(), "void-os-wt", `issue-${issueNum}`);
  if (!existsSync(worktree)) return c.text(`worktree ${worktree} does not exist — create it first`, 412);
  const runner = resolveRunner(readConfig(vault));
  const max = Number(body.max ?? 12);
  // fire-and-forget; the parked/complete state is observable via the session list
  drain({
    vault, worktree, issueNum, runner, max,
    // Always re-fetch (Forge #4 idempotency depends on a fresh body each iteration).
    fetchBody: async () => {
      const proc = Bun.spawn(["gh", "issue", "view", String(issueNum), "--json", "body", "-q", ".body"], { cwd: worktree, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    },
    // Safe close (Forge #4): drain only calls this after allChecked(refetched) is true.
    closeIssue: async () => {
      await Bun.spawn(["gh", "issue", "close", String(issueNum)], { cwd: worktree }).exited;
    },
  });
  return c.redirect("/");
});
```

- [ ] **Step 2: Add an agent-inbox panel to the dashboard**

In `src/render.ts` `renderDashboard`, add a panel that lists sessions whose `skill === "ralph"` and `status === "awaiting"` (read from the `SessionInfo[]` already passed in). Each row links to `/s/<uuid>` where the operator sees the artifact + the accept/edit/feedback form (that form is rendered by the ralph agent into `body.html`, posting to `/s/<uuid>/send`). Title the panel "Agent inbox — pending verdicts". If none, render an empty-state line.

(Match existing `renderDashboard` markup style; keep it a server-rendered HTML fragment.)

- [ ] **Step 3: Add a server test for the inbox filter + /drain guard**

In `tests/server.test.ts`, add:
- a test that `POST /drain` with a non-existent worktree returns 412.
- a test that `renderDashboard` output contains "Agent inbox" and lists a seeded awaiting ralph session.

(Follow the existing test harness in `tests/server.test.ts` — it builds the app via `makeApp(vault)` against a tmp vault.)

- [ ] **Step 4: Run tests + verify**

Run: `bun run verify`
Expected: `VERIFY GREEN`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/render.ts tests/server.test.ts
git commit -m "feat(drain): POST /drain route + dashboard agent-inbox for human-gate verdicts"
```

---

## Task 7: Optional e2e — fake-runner drain to green

**Files:**
- Create: `tests/e2e-ralph-drain.ts`

This is a smoke-first e2e (see [[feedback_e2e_plan_smoke_first]]): FIRST run an existing sibling e2e (`bun tests/e2e-transcript-drawer.ts`) to confirm the harness + server boot work, THEN write this one. If the sibling does not pass cleanly in your environment, SKIP this task and rely on the Task 5/6 integration tests — do not burn time fighting the harness.

- [ ] **Step 1: Run the sibling e2e to confirm the harness works**

Run: `bun tests/e2e-transcript-drawer.ts`
Expected: it boots a server + drives Playwright to a pass. If it fails, STOP this task (record why), skip to Task 8.

- [ ] **Step 2: Write `tests/e2e-ralph-drain.ts`** mirroring the sibling's structure: boot `makeApp` against a tmp vault, configure a fake runner (the `tests/fixtures/fake-ralph.ts` script), seed a one-box synthetic Issue body via a stubbed `fetchBody`, POST /drain, assert the dashboard shows the drain reaching `complete` (no awaiting session) within MAX. Watch the documented e2e traps ([[feedback_void_os_e2e_gotchas]]).

- [ ] **Step 3: Run it**

Run: `bun tests/e2e-ralph-drain.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-ralph-drain.ts
git commit -m "test(drain): e2e fake-runner drain reaches complete"
```

---

## Task 8: Author the first real dogfood Issue + run the end-to-end drain

**This is the acceptance phase. It runs REAL `vc` sessions and mutates a REAL GitHub Issue. NO push to `main` — commits accumulate on a branch in the worktree.**

**Chosen first dogfood feature (confirmed in plan):** *"Drain-run status surface"* — make the dashboard show, for each ralph drain, how many boxes are checked vs total for its Issue. This is a small, self-contained void-os feature that the loop builds inside void-os (true dogfood), it naturally yields ≥2 auto boxes + ≥1 human box, and it self-bootstraps a gap the PoC itself exposed (the dashboard currently shows individual sessions but no per-Issue drain progress).

**Box breakdown for the dogfood Issue (confirmed):**
1. `- [ ] Add drainProgress(body) → {checked,total} in src/issue.ts {auto: bun run verify} {p1}` — pure function over a box list; unit-tested.
2. `- [ ] Render a "Drain N/M boxes" badge per ralph session on the dashboard {auto: bun run verify} {p2}` — uses #1; server test asserts the badge text.
3. `- [ ] Polish the badge's empty/complete-state copy + color {human} {p3}` — human gate: agent renders a preview to body.html, operator eyes the tone/color and accepts.

(Deliberately one of the two auto boxes also doubles as the **red-blocks proof** in Step 4 below.)

- [ ] **Step 1: Create the worktree (NO push posture)**

```bash
git -C /Users/admin/hub/workspace/void-os worktree add ~/void-os-wt/issue-1 -b ralph/issue-1 main
```

(Issue number is assigned by `gh` in Step 2; rename the worktree dir + branch to match the real number, or create the issue first then the worktree. Prefer: create the Issue first, read its number, then `worktree add ~/void-os-wt/issue-<num> -b ralph/issue-<num>`.)

- [ ] **Step 2: Author the Issue via `gh`**

```bash
gh issue create --repo makscee/void-os \
  --title "Drain-run status surface" \
  --body "$(cat <<'EOF'
Dogfood Issue for the ralph drain PoC. Schema: docs/ralph/issue-schema.md

- [ ] Add drainProgress(body) → {checked,total} in src/issue.ts {auto: bun run verify} {p1}
      Pure function: parse the Issue body, return counts. Unit-tested in tests/issue.test.ts.
- [ ] Render a "Drain N/M boxes" badge per ralph session on the dashboard {auto: bun run verify} {p2}
      Uses drainProgress. Server test asserts the badge renders "N/M boxes".
- [ ] Polish the badge empty/complete-state copy + color {human} {p3}
      Agent renders a preview to body.html; human accepts the tone/color.
EOF
)"
```

Record the issue number `<NUM>`.

- [ ] **Step 3: Run the drain end-to-end**

Start the server (`bun run serve`), open the dashboard, press the ralph drain button (or `POST /drain` with `issue=<NUM>`). Watch:
- Box #1 (`p1`, auto): a fresh session implements `drainProgress`, runs `bun run verify` green, checks the box, commits. `run-1.log` written.
- Box #2 (`p2`, auto): next fresh session adds the badge, verify green, checks box, commits.
- Box #3 (`p3`, human): a fresh session renders a preview to `body.html` + emits `NEEDS HUMAN`; the drain parks; the dashboard agent-inbox shows it pending. Operator submits `verdict: accept` via the form (`POST /s/<uuid>/send`); a resumed session checks the box + commits; emits `PROMISE COMPLETE HERE`; the runner closes the Issue.

- [ ] **Step 4: Red-blocks proof**

Before the real run (or as a separate scratch Issue), seed one auto box with a check that CANNOT pass on first try (e.g. an acceptance criterion requiring a function the agent must write, where the test is pre-written failing). Confirm in `run-N.log` + `progress.txt`:
- the box is NOT checked while red,
- inline recovery is attempted (≤3 tries visible in the log),
- on exhaustion a `FAILED:` line lands in `progress.txt` and the iteration ends without checking the box.

Capture this as part of the evidence.

- [ ] **Step 5: Capture evidence**

- `cat ~/.void-os/sessions/<uuid>/run-*.log` for the drain (the `run-N.log` per box) + each `signal.txt` showing the terminal signal the runner acted on.
- `git -C ~/void-os-wt/issue-<NUM> log --oneline` showing one commit per box (commits in the WORKTREE — proves the cwd/vault split, Forge #2).
- `cat ~/void-os-wt/issue-<NUM>/progress.txt` showing DONE/FAILED/NEEDS HUMAN lines. progress.txt is deleted at drain end (Forge #4 — only after allChecked); capture it BEFORE the final close, OR copy it aside during the run.
- Playwright/manual screenshot of the dashboard agent-inbox: human box pending, then resolved.
- `gh issue view <NUM>` showing all boxes `- [x]` and the Issue closed.

- [ ] **Step 5b: Idempotency + safe-close proof (Forge fix #4)**

Demonstrate crash/re-run safety without breaking the real drain:
- After ≥1 box is checked, kill the drain mid-run (or let MAX trip on a scratch Issue), then re-`POST /drain`. Confirm the re-run SKIPS already-checked boxes (the re-fetched body shows them `- [x]`; no duplicate commits for them).
- Confirm the Issue is closed ONLY after `allChecked(refetched body)` — `gh issue view <NUM>` is `OPEN` while any box is unchecked, `CLOSED` only once all are `- [x]`.
- Confirm `progress.txt` still exists mid-drain and is gone only after the complete close.

- [ ] **Step 5c: cache_control verification (Forge fix #5)**

Prove the prefix-stable prompt is actually being cached (a VRL-30-class relay strip would functionally pass but cost ~10x). Capture ONE of:
- an outbound Anthropic request body from the drain showing a `cache_control` block on the stable prefix (e.g. via the relay's request log, or `LOG_RAW_API_PAYLOADS` on void-fcc TEMPORARILY — then disable + purge per [[feedback_fcc_raw_payload_logging_privacy]]), OR
- a usage record from a drain turn showing `cache_read_input_tokens > 0` (cache hit on iteration ≥2, which reuses the stable SKILL+references prefix).

Record the captured evidence inline. If neither cache_control nor a cache-read hit is observable, that is a FINDING to surface (relay may be stripping it) — do not silently pass T8.

- [ ] **Step 6: Confirm NO push happened**

```bash
git -C ~/void-os-wt/issue-<NUM> log origin/main..HEAD --oneline   # shows unpushed commits
git -C ~/void-os-wt/issue-<NUM> status                            # branch ahead of origin, not pushed
```

Expected: commits exist locally on `ralph/issue-<NUM>`, NOT on `origin/main`. Do NOT `git push`.

- [ ] **Step 7: Final verify on the branch**

Run (in the worktree): `bun run verify`
Expected: `VERIFY GREEN`.

---

## Self-Review (run after writing — done)

- **Spec coverage:** every `## Done when` bullet maps to a task — verify cmd (T1), ralph SKILL.md (T3), Issue schema (T2), drain runner self-select+MAX+early-exit+park (T5), auto-gate recovery (T3 prompt + T8 proof), human-gate via /send (T3+T6), real drain ≥2 auto + ≥1 human (T8), red-blocks proof (T8 S4), no push (T8 S6), evidence (T8 S5). ✓
- **Sequencing:** Phases 1→2→3→4 strictly sequential (drain needs schema+SKILL+verify). Within P3, T4→T5→T6 sequential. ✓
- **Shippability:** each phase lands a self-contained, tested unit; no half-broken intermediate. ✓
- **Scope discipline:** no MCP, no prd.json, no merge-gate, no AFK/eval layer — all explicitly out of scope per design. ✓
- **Premise check:** spawn/launch/send/argv/gh/worktree/session-model all verified against repo at plan time (see Load-bearing facts). The one wrinkle — `spawnTurn` is fire-and-forget + cwd=vault — is resolved by the new awaitable `runTurn(cwd, ...)` in T5. ✓
- **Forge fixes folded (2026-05-31 re-plan):**
  - #1 signal file — `signalPath` in paths.ts (T5 S1); SKILL writes `signal.txt` (T3 Signal contract); `classifyOutcome` reads it, not body.html (T5 S3 test + drain.ts); body.html keeps the human-gate `<form>` so `deriveStatus` still marks `awaiting`. ✓
  - #2 cwd/vault split — `runTurn(cwd, vault, …)` explicit (T5); dedicated split test asserts commit-in-worktree + signal-in-vault + resume-after-gate no split-brain (T5 S8). ✓
  - #3 lost-update guard — `checkBox(body, box)` targeted single-line flip (T4) + SKILL re-fetch-before-write + serialize-through-runner rule (T3 Process step 4). ✓
  - #4 idempotent drain + safe close — re-fetch each iter, skip checked, delete progress.txt + close ONLY after allChecked(refetched) (drain.ts `finishComplete`); proof in T8 S5b. ✓
  - #5 cache_control verification — capture step in T8 S5c (cache_control present OR cache-read hit). ✓
