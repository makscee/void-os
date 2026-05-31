# Gated Drain-Loop PoC Implementation Plan (v2 — runner-owned gates, skill-decoupled)

**Goal:** A single generic Issue-drain loop over the void-os web dashboard. A server-side **drain runner** (`src/drain.ts`) owns the mechanical loop: it parses an Issue into Boxes, **assigns** the next open Box by priority, spawns a fresh skill session in a worktree to work ONLY that Box, awaits exit, **runs the Box's gate itself**, and on pass does the targeted `gh` checkbox write + commit. `ralph` is the FIRST drainable skill — but orchestration never hardcodes it (`drain(issueNum, {skill, …})`). One real GitHub Issue is drained end-to-end in a worktree, NO push.

**This is the v2 architecture.** It supersedes the earlier "agent self-selects the Box + self-reports its gate outcome via `signal.txt`" design. The runner↔agent self-report contract was the root of nearly every forge finding across two passes; v2 removes it structurally by moving box-selection, gate-running, checkbox-writing and completion-detection into the runner. The skill does only work.

**Tech Stack:** Bun + TypeScript, Hono (existing server), `bun test`, `bunx tsc --noEmit`, Playwright (existing e2e harness), `gh` CLI (authenticated, `repo` scope on `makscee/void-os`), git worktrees at `~/void-os-wt/<issue>/`.

---

## v2 architecture — the two decisions this plan implements

**Decision A — the runner owns the mechanical loop; the skill only does work.**

Per iteration, `drain()`:
1. asserts the worktree is clean (`git status --porcelain` empty), else returns `dirty-worktree`;
2. re-fetches the Issue body (idempotent) and parses Boxes;
3. if `allChecked` → completes (comment, not close); if no open Box → `stalled`;
4. picks `nextOpenBox` by priority and **assigns** it;
5. **branches on the Box's gate, which the runner reads from the parsed annotation BEFORE spawning:**
   - **`human`** → spawn the skill session to produce the artifact + a markdown review summary into `body.html` (which MUST contain a `<form>` so `deriveStatus` marks it `awaiting`); the runner then **parks** (`parked-human`) — no agent-emitted token needed.
   - **`auto: <check>`** → spawn the skill session to work the Box, await exit, then the **RUNNER runs `<check>` in the worktree and reads the exit code directly**:
     - green → the runner does the targeted `checkBox` write via `gh` (re-fetch immediately before write — runner owns the write, no lost-update race) + commits + appends `progress.txt`; loop.
     - red → re-spawn the SAME Box with the failure fed forward, up to N attempts; still red → terminal `failed` (no budget burn to MAX).
6. on `allChecked(refetched)` → comment "drained locally, unpushed" + leave the Issue OPEN; delete `progress.txt`.

The skill does NOT select the Box, does NOT run the gate for control flow, does NOT write checkboxes, does NOT self-report an auto outcome.

**Decision B — orchestration decoupled from the concrete skill (a seam, not a framework).**

`drain(issueNum, {skill, …})` threads `skill` into the launch argv (`/<skill> <assigned-box-prompt>`). Orchestration never hardcodes `"ralph"`. **Scope guard (YAGNI):** parameterize ONLY — NO skill registry, NO selection UX, NO per-skill config. The seam exists; the framework does not until a second skill is real.

**Naming:** the concept is the **gated drain loop** (generic); `ralph` is a skill. The glossary (`CONTEXT.md`) + ADR-0001 are updated to separate drain-orchestration from skill (Task 7).

**What v2 RETIRES structurally** (these forge findings no longer apply because the agent no longer writes a signal or touches `gh` for auto gates):
- pass-1 #1 (signal.txt vs body.html for auto/complete) — runner derives outcome from the exit code + `allChecked`.
- pass-2 #2-as-FAILED-classification — runner knows red directly from the exit code.
- pass-2 #5 (timeout partial-signal) — no agent signal to be partial.
- the **auto-box case** of pass-1 #3 (lost-update) — the runner owns the checkbox write; only ONE writer for auto boxes.

**What v2 STILL carries (binding):** fresh-context-per-box; Issue-as-store-of-record; files-as-state; worktree + NO push; cwd/vault split (`runTurn(cwd=worktree)`, state under `sessionDir(vault,uuid)`); idempotent drain (re-fetch each iter, skip checked); targeted lost-update-safe checkbox write (re-fetch immediately before write — still matters for the **human** box, where the operator may reshape concurrently); comment-not-close; `progress.txt` fed each iter (tailed ~40 lines) + deleted only after confirmed complete; cache_control verify (T8); bypassPermissions = accepted-risk PoC note; mandatory MAX backstop.

**`signal.txt` — DEFERRED for the PoC (planner decision).** v2 reduces `signal.txt` to an OPTIONAL `BLOCKED:` escape hatch. For this PoC it is **not built**: the runner derives auto-pass/fail from the gate exit code, human-park from the annotation, and completion from `allChecked`. A skill that genuinely cannot proceed will simply fail its auto gate (red → N retries → terminal `failed`) or leave its human box's `body.html` without a `<form>`. Building a `BLOCKED:` reader is YAGNI here. NOT dropped from the design — revisit when a non-coding skill (research/review) needs to abort cleanly mid-Box. (No `signalPath`, no `classifyOutcome`, no agent signal-write instruction in this plan.)

---

## Load-bearing facts (re-verified against the repo 2026-05-31 for the v2 pivot — do NOT re-derive)

- **Session model:** `~/.void-os/sessions/<uuid>/` holds `body.html`, `error.txt`, `run-N.log`, `session-meta.json`. Vault root = `process.env.VOID_OS_VAULT ?? ~/.void-os` (`src/paths.ts:vaultRoot`). Verified.
- **`spawnTurn(vault, uuid, argv, command)`** (`src/spawn.ts:57`) is `void` / fire-and-forget, hardcodes `cwd: vault`, has a 12-min watchdog + error.txt-on-no-advance logic. The drain runner CANNOT reuse it — it needs an **awaitable** spawn with an explicit `cwd`. `Bun.spawn(...).exited` is a promise. Verified.
- **argv builders** (`src/spawn.ts`): `buildLaunchArgv(uuid, skill, text)` → `["--session-id", uuid, "-p", "/<skill> <text>", "--permission-mode", "bypassPermissions"]`; `buildAnswerArgv(uuid, text)` → `["--resume", uuid, "-p", "<RENDER_PREAMBLE>\n<text>", ...PERM]`; `tokenizeCommand(cmd)` splits a runner prefix like `"vc --"`. Verified.
- **Runner command** resolved from `void-os.json` via `resolveRunner(readConfig(vault), label?)`; default `"vc --"`. Verified (`src/paths.ts:53`).
- **`POST /launch`** (`src/server.ts:32–65`): relay-auth guard → `randomUUID()` → mkdir session dir → write `session-meta.json` `{skill, launchedAt, text, runner}` → write placeholder `body.html` → `spawnTurn(...)` → redirect. Verified.
- **`POST /s/:uuid/send`** (`src/server.ts:142–166`): serializes ALL form fields as `key: value\n`, recovers ONLY `runner` from `session-meta.json` today (NO drain context), `spawnTurn(vault, uuid, buildAnswerArgv(uuid, text), runner)` (cwd=vault), returns `c.html(workingPage(fields))`. **This is the human-gate verdict path.** v2 hooks here (Task 6): recover `{drainIssue, worktree, max, skill}` from meta and, IF present, resume the parked session via **`runTurn(cwd=worktree, …, buildAnswerArgv(uuid, text), runner)`** (NOT `spawnTurn` cwd=vault — else the resumed agent's commit/`gh` edit have no repo), then re-invoke `drain({issueNum, …})`. Verified against the real handler.
- **`session-meta.json` shape today** = `{skill, launchedAt, text, runner}` (written at `src/server.ts:56–59`, read at `:75` and `:159` and `src/sessions.ts:53`). v2 drain extends it with `{drainIssue, worktree, max}` for parked human sessions. Verified.
- **`deriveStatus`** (`src/sessions.ts:24–28`): `error.txt` → `error`; `body.html` contains `<form` → `awaiting`; else `complete`. The human-park session MUST write a `<form>` into `body.html` to surface in the inbox. Verified.
- **`gh issue comment <num> --body <text>`** posts a comment + leaves the Issue OPEN. `gh issue edit` (gh 2.89.0) exposes only `--body`/`--body-file` (whole-body replacement) — no targeted checkbox API. So the runner's `checkBox` flips a single line on a freshly-fetched body. Verified.
- **Dashboard** (`renderDashboard` in `src/render.ts`, `listSessions` in `src/sessions.ts`): status derived purely from filesystem. `renderDashboard(skills, sessions, {authed}, cfg)` returns a server-rendered HTML fragment; `SessionInfo` carries `{uuid, title, mtimeMs, error, status, skill}`. Verified.
- **`gh`** authenticated as `makscee`, `repo` scope, remote `makscee/void-os`, ZERO open issues (clean slate), branch `main`. Worktrees at `~/void-os-wt/<id>/`. Verified.
- **Tests:** `package.json` scripts are only `test` (`bun test`) + `serve`. `bunx tsc --noEmit` exits 0 today. Unit tests `tests/*.test.ts`; e2e are plain `bun tests/<file>.ts` driver scripts (e.g. `tests/e2e-transcript-drawer.ts`), NOT the `@playwright/test` runner. Verified.
- **`tests/server.test.ts` mocks `src/spawn.ts` via `mock.module("../src/spawn.ts", …)`** (stubs `buildLaunchArgv`/`buildAnswerArgv`/`spawnTurn` into a `spawnCalls` array), imported BEFORE `makeApp`. **The v2 server test for the `/send` re-invoke MUST extend this mock to also stub `runTurn`** (and assert it ran with `cwd=worktree`), or the resume path will call the real `runTurn`. Verified (`tests/server.test.ts:19`).
- **Existing fixture:** `tests/fixtures/fake-runner.sh` is a shell script that records argv + writes `body.html` + exits 0. v2's fake skill must additionally make a real `git commit` in CWD and (for the auto-gate exercise) leave the worktree in a state where the runner's gate check passes/fails as the test directs. New fixture `tests/fixtures/fake-skill.ts`.
- **NO existing `drain`/`runTurn`/`parseBoxes`/`checkBox`/`nextOpenBox` in `src/` or `tests/`** (grep-verified) — all new. Existing tests: `catalog`, `server`, `render`, `sessions`, `spawn`, `paths`, `configurable-runner`, `onboarding`, `transcript`, `preflight`, `scaffold`, `frontmatter`, `init`, `serve`, `tui` + `e2e-transcript-drawer.ts` + `e2e-vos-184-session-polish.ts`.
- **Relay cache_control:** the `vc` relay must pass `cache_control` through untouched ([[feedback_relay_header_merge_not_clobber]]). This PoC does not modify the relay; T8 captures one outbound call with `cache_control` present OR a cache-read usage hit. Verified the concern is live.
- **Canon docs live in the VAULT, not the repo:** `CONTEXT.md` + `adr/0001-ralph-gated-loop.md` are at `vault/projects/void-os/`, NOT in `workspace/void-os`. Task 7 edits the vault copies (committed direct to hub master, NOT void-os). Verified.

**Accepted risk (operator: skip).** Each iteration spawns a fresh agent with `--permission-mode bypassPermissions`, unattended up to MAX. No fence added — accepted for a disposable-Issue PoC on the author's own repo; revisit before AFK / untrusted-Issue use (already out of scope). NO code change.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | add `verify` npm script (Task 1) |
| `scripts/verify.sh` (new) | single scriptable green/red gate: `bunx tsc --noEmit` + `bun test` (Task 1) |
| `docs/ralph/issue-schema.md` (new) | canonical Box/story schema — `- [ ]` + criteria + `{auto: <check>}`\|`{human}` + `{pN}` (Task 2) |
| `catalog/skills/ralph/SKILL.md` (new) | the SHRUNK skill contract: INPUT = one assigned Box + worktree + selective refs; OUTPUT = code changes (+ human box: markdown review summary with a `<form>` into `body.html`). NO self-select, NO gate-run, NO checkbox write, NO signal (Task 3) |
| `src/issue.ts` (new) | `parseBoxes(body)→Box[]`; `nextOpenBox`; `allChecked`; `checkBox(body, box)` targeted single-line flip; `drainProgress(body)→{checked,total}` (Task 4) |
| `src/spawn.ts` | factor an awaitable `runTurn(cwd, vault, uuid, argv, command): Promise<number>`; explicit `cwd` = worktree (code plane) while session state stays under `sessionDir(vault,…)` (state plane) (Task 5) |
| `src/drain.ts` (new) | the generic drain runner: runner-owned loop (assign Box → spawn skill → **runner runs the gate** → checkbox write + commit → loop), `skill` param, auto red→N→`failed`, human-park, idempotent + comment-not-close, clean-tree guard, `buildDrainPrompt` tails progress.txt, persists `{drainIssue,worktree,max}` to parked meta (Task 5) |
| `src/server.ts` | `POST /drain` launch route (skill defaults to `"ralph"`); the existing `POST /s/:uuid/send` resumes a parked drain via `runTurn(cwd=worktree)` then re-invokes `drain()` (Task 6) |
| `src/render.ts` | agent-inbox panel: list awaiting drain sessions with the operator's accept/edit/feedback flow (Task 6) |
| `tests/issue.test.ts`, `tests/drain.test.ts` (new) | unit + integration tests (Tasks 4–5) |
| `tests/fixtures/fake-skill.ts` (new) | fake skill that ONLY edits files + commits in CWD; the runner gates it (Task 5) |
| `tests/e2e-ralph-drain.ts` (new, optional) | smoke-first e2e driving a fake-skill drain to complete (Task 6) |
| `vault/projects/void-os/CONTEXT.md` + `adr/0001-ralph-gated-loop.md` | flip "agent self-selects / Runner does not assign" → runner-owned; add the skill-decoupled seam (Task 7 — VAULT, hub master) |

---

## Phase / shippability map

- **Phase 1 (Task 1)** — `verify` command. Shippable: a green/red script.
- **Phase 2 (Tasks 2–3)** — Issue schema doc + shrunk `ralph` SKILL.md. Shippable: a launchable skill + documented schema; no runner yet.
- **Phase 3 (Tasks 4–6)** — `src/issue.ts` + `src/drain.ts` runner + server/inbox wiring. Shippable: drain runnable against a synthetic Issue with a fake skill; runner-owned auto + human gates exercised by unit/integration tests.
- **Phase 4 (Task 7)** — flip the glossary + ADR to runner-owned + skill-decoupled. Shippable: canon docs consistent with the code. (Doc-only; can land any time after the design is settled, but placed here so it reflects the as-built loop. VAULT repo, committed to hub master — NOT void-os.)
- **Phase 5 (Task 8)** — author the FIRST real dogfood Issue + run the end-to-end drain in a worktree; capture evidence.

Phases 1→2→3 are strictly sequential (the runner depends on the schema + SKILL + verify). Within Phase 3, Task 4 → 5 → 6 are sequential (runner depends on issue parsing; server wiring depends on the runner). Task 7 depends on Phase 3 being designed (it documents the as-built loop). Phase 5 needs all of 1–3 (and benefits from 7 being done so the agent reads consistent canon).

---

## Task 1: Single `verify` command

**Files:** create `scripts/verify.sh`; modify `package.json` (scripts).

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

- [ ] **Step 2: `chmod +x scripts/verify.sh`; add `"verify": "bash scripts/verify.sh"` to `package.json` `scripts`** (keep existing `test` + `serve`).
- [ ] **Step 3: Run `bun run verify`** — expect it to end `VERIFY GREEN`, exit 0 on a clean tree.
- [ ] **Step 4: Confirm red is scriptable** — a failing `tsc`/test makes `bun run verify` exit non-zero without printing `VERIFY GREEN`.
- [ ] **Step 5: Commit** — `git add scripts/verify.sh package.json && git commit -m "feat(verify): single scriptable green/red gate (bun test + tsc)"`

---

## Task 2: Issue/story schema doc

**Files:** create `docs/ralph/issue-schema.md`. Canonical source — `src/issue.ts` implements exactly this grammar; do not duplicate it elsewhere.

- [ ] **Step 1: Write the schema doc** (verbatim — this IS the spec the parser implements):

````markdown
# Issue / Story Schema (gated drain loop)

A **drain unit** is one GitHub Issue. Its body is a task-list of **Boxes**.
The drain loops over the open Boxes until all are checked, then comments
("drained locally, unpushed") and leaves the Issue OPEN (no-push PoC posture).
This file is the single canonical home for the Box grammar — `src/issue.ts`
implements exactly this. Do not redefine it elsewhere.

## Box grammar

Each Box is one GitHub task-list item:

```
- [ ] <title> {gate} {prio}
      <acceptance criteria — one or more indented lines>
```

- `- [ ]` unchecked / `- [x]` checked — the durable done-state, owned by the
  **runner** (via `gh`). The skill never touches the checkbox.
- `<title>` — short imperative summary of the story.
- `{gate}` — REQUIRED. Exactly one of:
  - `auto: <shell-check>` — a machine gate. `<shell-check>` is a command the
    **runner** runs from the worktree root after the skill session exits;
    exit 0 = green. Usually `bun run verify`, may be narrower
    (e.g. `bun test tests/foo.test.ts`).
  - `human` — an async review-as-gate. The skill produces an artifact + a
    markdown review summary into the session's `body.html`; the runner parks
    and the operator gives a verdict in the dashboard agent-inbox.
- `{prio}` — REQUIRED. `p1` (highest) .. `pN`. The **runner** picks the
  highest-priority OPEN Box each iteration and assigns it to the skill.
- Acceptance criteria — indented prose under the Box; the definition-of-done.

## Annotation placement

Gate + priority live in a trailing brace group on the Box title line:

```
- [ ] Add /healthz route returning 200 {auto: bun run verify} {p1}
      Route GET /healthz returns HTTP 200 with body "ok".
- [ ] Polish the dashboard empty-state copy {human} {p3}
      Render an inviting empty-state; needs a human eye on tone.
```

## Drain lifecycle (runner-owned)

1. Runner re-fetches the Issue body, parses Boxes, asserts a clean worktree.
2. Runner picks the highest-priority open Box and assigns it to a fresh skill
   session (cwd = worktree), feeding it the Box + the `progress.txt` tail.
3. Skill works ONLY that Box and exits. It does NOT run the gate, check the
   box, or report an outcome.
4. Runner runs the Box's gate:
   - `auto`: runner runs `<check>`. Green → runner checks the box (`gh`) +
     commits + appends `progress.txt`; loop. Red → re-spawn the same Box with
     the failure fed forward, up to N; still red → terminal `failed`.
   - `human`: runner parks; operator verdict resumes the skill, then the
     runner continues the loop.
5. All Boxes checked → runner comments "drained locally, unpushed", leaves the
   Issue OPEN, deletes `progress.txt`.
````

- [ ] **Step 2: Commit** — `git add docs/ralph/issue-schema.md && git commit -m "docs(ralph): canonical Issue/story Box schema (runner-owned gates)"`

---

## Task 3: `ralph` SKILL.md — the shrunk skill contract

**Files:** create `catalog/skills/ralph/SKILL.md`. Must be discoverable by `listCatalogSkills` (needs `name` + `description` frontmatter) and self-documenting for a zero-prior-context agent.

The v2 skill is DELIBERATELY SMALL: input = one assigned Box; output = code changes in the worktree (+ human box: a markdown review summary with a `<form>` into `body.html`). It does NOT select the Box, run the gate, write checkboxes, or write a signal file.

- [ ] **Step 1: Write the SKILL.md** (verbatim):

````markdown
---
name: ralph
description: Works ONE assigned Box of a gated Issue-drain. Makes the minimal code change the Box's acceptance criteria require, in the worktree, then stops. The runner assigns the Box, runs the gate, and checks the box — you do not.
---

# ralph — work one assigned Box

You are a FRESH void-os session with NO memory of prior iterations. The drain
**runner** has already chosen ONE Box for you and put it in your launch prompt.
Work ONLY that Box, then stop. You do NOT pick the Box, run its gate, check the
checkbox, close anything, or write any status/signal file — the runner does all
of that after you exit.

## Inputs (read selectively — token-budgeted, ~2–8k; do NOT read whole files)

- **Your assigned Box** — title + acceptance criteria, in your launch prompt.
  Schema reference: `docs/ralph/issue-schema.md` (read only if the grammar is
  unclear).
- **`progress.txt`** — a recent tail of append-only scratch memory in your cwd
  (the worktree). Read it to learn what prior iterations did / what failed.
  May be `(empty)` on iteration 1.
- **`git log --oneline -10`** — recent commits, the durable history.
- **Stable references** — `CONTEXT.md`, repo standards, the `verify` spec. Read
  only the SECTION relevant to your Box, never whole files.

## Process

1. **Work your assigned Box.** Make the minimal code/doc change its acceptance
   criteria require. Do NOT attempt other Boxes.
2. **Render progress** to this session's `body.html` (resolve `$VOID_OS_SESSION`,
   write `sessions/<id>/body.html` under the vault) so the dashboard shows what
   you did. Keep it presentation-only.
3. **For a `human` Box:** your job is to make the change reviewable, not to pass
   any check. Render into `body.html`: (a) a short markdown review summary of
   what you changed and what the human should eye, and (b) an accept / edit /
   natural-language-feedback `<form>` posting to `/s/$VOID_OS_SESSION/send`.
   The `<form>` is REQUIRED — it is what marks this session `awaiting` so the
   runner parks and the inbox surfaces you. Then STOP.
4. **Leave the worktree clean of scratch.** Anything you create and do not need
   (`*.tmp`, half-written fixtures), DELETE before you exit — the runner
   refuses to start the next Box if the worktree is dirty, and it will stage
   exactly your changes when it commits on a green gate.
5. **Stop.** Do NOT run the gate, do NOT `gh issue edit`/check the box, do NOT
   commit (the runner commits on a green auto gate or after the human verdict),
   do NOT write a signal file. The runner inspects your work after you exit.

## Resume-after-human-verdict

If your launch prompt contains a human verdict (`verdict: accept` /
`verdict: edit` / `feedback: <text>`), you were resumed to act on it:
- `accept` → nothing more to change; render a brief "accepted" note to
  `body.html` WITHOUT a `<form>` (so you are no longer `awaiting`) and STOP. The
  runner will check the box + commit + continue the loop.
- `edit` / `feedback` → apply the feedback (it MAY reshape the Issue's Boxes —
  add/remove/rewrite via `gh issue edit` — not just revise one diff), render the
  updated artifact + a fresh `<form>` to `body.html`, and STOP for another
  verdict round.

## Outputs (contract)

- Code/doc changes in the worktree (uncommitted — the runner commits).
- `body.html` rewritten (dashboard presentation). For a human Box it MUST carry
  the accept/edit/feedback `<form>`.
- NOTHING ELSE. No checkbox write, no commit, no gate run, no signal file.
- NEVER carry state in the terminal conversation — only files (the worktree,
  `progress.txt`, `body.html`).
````

- [ ] **Step 2: Confirm discoverable** — `bun -e 'import {listCatalogSkills} from "./src/catalog.ts"; console.log(listCatalogSkills("./catalog").map(s=>s.name))'` → array includes `"ralph"`.
- [ ] **Step 3: Add a catalog test** asserting `listCatalogSkills` returns a skill named `ralph` with a non-empty description (match the existing style in `tests/catalog.test.ts`).
- [ ] **Step 4: `bun test tests/catalog.test.ts`** → PASS.
- [ ] **Step 5: Commit** — `git add catalog/skills/ralph/SKILL.md tests/catalog.test.ts && git commit -m "feat(ralph): shrunk skill contract — works one assigned Box, runner owns gates"`

---

## Task 4: `src/issue.ts` — Box parser + runner-owned checkBox + nextOpenBox

**Files:** create `src/issue.ts`; test `tests/issue.test.ts`. TDD.

- [ ] **Step 1: Write the failing test:**

```typescript
// tests/issue.test.ts
import { test, expect } from "bun:test";
import { parseBoxes, allChecked, checkBox, nextOpenBox, drainProgress } from "../src/issue.ts";

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

test("nextOpenBox returns the highest-priority OPEN box (lowest prio number)", () => {
  expect(nextOpenBox(parseBoxes(BODY))?.title).toBe("Add /healthz route");
  const allDone = BODY.replace(/- \[ \]/g, "- [x]");
  expect(nextOpenBox(parseBoxes(allDone))).toBeUndefined();
});

test("allChecked false when an open box remains, true when all checked", () => {
  expect(allChecked(parseBoxes(BODY))).toBe(false);
  expect(allChecked(parseBoxes(BODY.replace(/- \[ \]/g, "- [x]")))).toBe(true);
});

// checkBox flips ONLY the target box's line — preserves everything else, so a
// concurrent operator reshape (human-box edit) is not clobbered. Runner-owned.
test("checkBox flips only the target box line, preserves everything else", () => {
  const out = checkBox(BODY, parseBoxes(BODY)[0]);
  expect(out).toContain("- [x] Add /healthz route {auto: bun run verify} {p1}");
  expect(out).toContain("Some preamble.");
  expect(out).toContain("- [x] Scaffold module {auto: bun test} {p2}");
  expect(out).toContain("- [ ] Polish empty-state copy {human} {p3}");
  expect(out.split("\n").filter((l, i) => l !== BODY.split("\n")[i]).length).toBe(1);
});

test("checkBox is idempotent on an already-checked box", () => {
  expect(checkBox(BODY, parseBoxes(BODY)[1])).toBe(BODY);
});

test("drainProgress returns {checked,total}", () => {
  expect(drainProgress(BODY)).toEqual({ checked: 1, total: 3 });
});
```

- [ ] **Step 2: Run `bun test tests/issue.test.ts`** → FAIL (`parseBoxes` undefined).
- [ ] **Step 3: Write `src/issue.ts`:**

```typescript
// src/issue.ts — parse a GitHub Issue body into Boxes (stories). Schema: docs/ralph/issue-schema.md
export type Gate = { kind: "auto"; check: string } | { kind: "human" };
export interface Box {
  title: string;
  checked: boolean;
  gate: Gate;
  prio: number;
  raw: string; // the full "- [ ] ..." line, for the targeted body re-write
}

const BOX_RE = /^- \[( |x)\] (.+)$/;

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

/** Highest-priority OPEN box (lowest prio number), or undefined if none open. */
export function nextOpenBox(boxes: Box[]): Box | undefined {
  return boxes.filter((b) => !b.checked).sort((a, b) => a.prio - b.prio)[0];
}

/**
 * Lost-update-safe checkbox flip (runner-owned). Given a freshly-fetched body and
 * the target box, return a new body with ONLY that box's `- [ ]` line changed to
 * `- [x]`, matched by the box's exact `raw` line. Every other byte is preserved
 * (so a concurrent operator reshape of a human box is not clobbered). Idempotent.
 * The CALLER (drain runner) MUST pass a body it re-fetched immediately before.
 */
export function checkBox(body: string, box: Box): string {
  if (box.checked) return body;
  const checkedLine = box.raw.replace(/^- \[ \]/, "- [x]");
  const idx = body.indexOf(box.raw);
  if (idx === -1) return body; // reshaped away — no-op
  return body.slice(0, idx) + checkedLine + body.slice(idx + box.raw.length);
}

export function drainProgress(body: string): { checked: number; total: number } {
  const boxes = parseBoxes(body);
  return { checked: boxes.filter((b) => b.checked).length, total: boxes.length };
}
```

- [ ] **Step 4: `bun test tests/issue.test.ts`** → PASS.
- [ ] **Step 5: Commit** — `git add src/issue.ts tests/issue.test.ts && git commit -m "feat(issue): parse boxes, nextOpenBox, runner-owned targeted checkBox, drainProgress"`

---

## Task 5: `src/drain.ts` runner (runner-owned gates) + awaitable `runTurn`

**Files:** modify `src/spawn.ts` (factor `runTurn`); create `src/drain.ts`; create `tests/fixtures/fake-skill.ts`; test `tests/drain.test.ts`. TDD.

**The runner's core invariant — cwd/vault split.** The skill's cwd is the worktree (so the runner's later `git commit` + `bun run verify` act on worktree code) while ALL session I/O (`runLogPath`/`errorPath`/`bodyPath`) resolves under the vault via `sessionDir(vault, uuid)` — verified decoupled (`spawnTurn` already hardcodes `cwd: vault` yet writes state via `sessionDir`). That is why `runTurn` takes `cwd` AND `vault` as separate args. The human-gate resume (`POST /s/:uuid/send` → `runTurn(cwd=worktree)`) and the drain spawns BOTH write to the same `sessionDir(vault, uuid)` — no split-brain.

- [ ] **Step 1: Factor an awaitable spawn in `src/spawn.ts`** (leave `spawnTurn` intact for the dashboard launch path; export `tokenizeCommand`/`nextRunIndex`/`SPAWN_TIMEOUT_MS` as needed, or inline):

```typescript
/**
 * Awaitable spawn of one runner turn. Returns the exit code. Unlike spawnTurn
 * (fire-and-forget, cwd=vault), this lets the drain runner await each iteration
 * and run it in an arbitrary cwd (the worktree). State I/O still resolves under
 * the vault via sessionDir — cwd and vault are independent.
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

- [ ] **Step 2: Write `src/drain.ts`** — the runner-owned loop:

```typescript
// src/drain.ts — generic server-side Issue-drain runner. The RUNNER owns the loop:
// it assigns a Box, spawns a fresh skill session to work it, then runs the Box's
// gate itself (auto: runs the check + reads the exit code; human: parks). The skill
// only edits files. `skill` is a parameter — orchestration never hardcodes "ralph".
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionDir, bodyPath } from "./paths.ts";
import { runTurn } from "./spawn.ts";
import { parseBoxes, nextOpenBox, allChecked, checkBox, type Box } from "./issue.ts";

export interface DrainOpts {
  vault: string;
  worktree: string;            // ~/void-os-wt/issue-<N>/
  issueNum: number;
  runner: string;              // "vc --"
  skill?: string;              // Decision B: the drainable skill; defaults to "ralph"
  max: number;                 // MANDATORY backstop
  autoRetries?: number;        // N inline re-spawns on a red auto gate (default 3)
  fetchBody: () => Promise<string>;                 // gh issue view --json body -q .body (re-fetch each iter)
  writeBody: (body: string) => Promise<void>;       // gh issue edit --body-file - (targeted, after checkBox)
  runGate: (check: string) => Promise<number>;      // runner runs the auto check in the worktree; returns exit code
  commit: (message: string) => Promise<void>;       // git add -A && git commit -m <message> in the worktree
  commentDrained?: () => Promise<void>;             // gh issue comment "drained locally, unpushed" — Issue stays OPEN
}

export interface DrainResult {
  status: "complete" | "parked-human" | "failed" | "max-reached" | "stalled" | "dirty-worktree";
  parkedUuid?: string;         // session awaiting a human verdict
  failedBox?: string;          // the auto box that stayed red after autoRetries
  iterations: number;
}

/** Tail progress.txt: inject only the last ~maxLines lines (or since the last `DONE:`)
 *  — protects the ~2–8k budget + the stable-prefix cache. progress.txt stays append-only. */
export function tailProgress(progress: string, maxLines = 40): string {
  if (!progress.trim()) return "(empty)";
  const lines = progress.split("\n");
  const lastDone = lines.map((l, i) => (l.startsWith("DONE:") ? i : -1)).filter((i) => i >= 0).pop();
  const start = lastDone !== undefined
    ? Math.min(lastDone, Math.max(0, lines.length - maxLines))
    : Math.max(0, lines.length - maxLines);
  return lines.slice(start).join("\n");
}

/** Build the launch prompt for the ONE assigned Box + the progress tail. */
export function buildDrainPrompt(issueNum: number, box: Box, progress: string): string {
  return [
    `Issue #${issueNum}. Your assigned Box (work ONLY this one):`,
    box.raw,
    `--- progress.txt (recent tail) ---`,
    tailProgress(progress),
  ].join("\n");
}

export async function drain(opts: DrainOpts): Promise<DrainResult> {
  const skill = opts.skill ?? "ralph";
  const retries = opts.autoRetries ?? 3;
  const progressPath = join(opts.worktree, "progress.txt");
  if (!existsSync(progressPath)) writeFileSync(progressPath, "");

  for (let i = 1; i <= opts.max; i++) {
    // Clean-tree guard: each Box starts from a committed tree so the runner's
    // `git add -A` captures only its own changes — never stray scratch from a crash.
    if ((await gitPorcelain(opts.worktree)).trim() !== "") {
      return { status: "dirty-worktree", iterations: i - 1 };
    }

    const body = await opts.fetchBody();          // re-fetch each iter (idempotent)
    const boxes = parseBoxes(body);
    if (allChecked(boxes)) return await finishComplete(i - 1);
    const box = nextOpenBox(boxes);
    if (!box) return { status: "stalled", iterations: i - 1 };

    const uuid = randomUUID();
    mkdirSync(sessionDir(opts.vault, uuid), { recursive: true });
    // Persist drain context so POST /s/:uuid/send can resume + re-invoke drain() after a human verdict.
    writeFileSync(
      join(sessionDir(opts.vault, uuid), "session-meta.json"),
      JSON.stringify({ skill, launchedAt: Date.now(), text: `drain #${opts.issueNum}`,
        runner: opts.runner, drainIssue: opts.issueNum, worktree: opts.worktree, max: opts.max }),
    );

    if (box.gate.kind === "human") {
      // Spawn once so the skill renders the artifact + <form> into body.html, then park.
      const progress = readFileSync(progressPath, "utf8");
      await spawnBox(uuid, box, progress);
      return { status: "parked-human", parkedUuid: uuid, iterations: i };
    }

    // auto gate — RUNNER runs the check after the skill exits; bounded inline recovery.
    const check = box.gate.check;
    let green = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const progress = readFileSync(progressPath, "utf8");
      await spawnBox(uuid, box, progress, attempt > 1
        ? `Previous attempt left the gate RED. Fix the cause.` : undefined);
      const code = await opts.runGate(check);       // runner runs the gate
      if (code === 0) { green = true; break; }
      appendProgress(progressPath, `RETRY ${attempt}: ${box.title} — gate red (exit ${code})`);
    }
    if (!green) {
      appendProgress(progressPath, `FAILED: ${box.title} — auto gate red after ${retries} attempts`);
      // Commit the FAILED progress line so the tree is clean for any re-run (no checkbox flip).
      await opts.commit(`progress: ${box.title} FAILED (auto gate red)`);
      return { status: "failed", failedBox: box.title, iterations: i };
    }

    // Green: runner owns the checkbox write (re-fetch immediately before — lost-update safe) + commit.
    const fresh = await opts.fetchBody();
    const target = parseBoxes(fresh).find((b) => b.raw === box.raw) ?? box;
    await opts.writeBody(checkBox(fresh, target));
    appendProgress(progressPath, `DONE: ${box.title}`);
    await opts.commit(box.title);
    // loop
  }
  return { status: "max-reached", iterations: opts.max };

  // --- helpers ---
  async function spawnBox(uuid: string, box: Box, progress: string, extra?: string): Promise<void> {
    const base = buildDrainPrompt(opts.issueNum, box, progress);
    const prompt = extra ? `${base}\n--- note ---\n${extra}` : base;
    const argv = ["--session-id", uuid, "-p", `/${skill} ${prompt}`, "--permission-mode", "bypassPermissions"];
    await runTurn(opts.worktree, opts.vault, uuid, argv, opts.runner);
  }

  async function finishComplete(iterations: number): Promise<DrainResult> {
    const fresh = parseBoxes(await opts.fetchBody());
    if (allChecked(fresh)) {
      await opts.commentDrained?.();            // comment — Issue stays OPEN
      if (existsSync(progressPath)) rmSync(progressPath);
      return { status: "complete", iterations };
    }
    return { status: "stalled", iterations };   // a box re-opened mid-flight
  }
}

function appendProgress(path: string, line: string): void {
  writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + line + "\n");
}

/** `git status --porcelain` in the worktree — empty string = clean tree.
 *  Non-repo dir (`git status` errors) → treat as clean (the guard is a scratch-leak net). */
async function gitPorcelain(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
  if ((await proc.exited) !== 0) return "";
  return await new Response(proc.stdout).text();
}
```

> **Design note for the implementer:** the gate, body-write, commit, and comment are INJECTED callbacks (`runGate`/`writeBody`/`commit`/`commentDrained`), not hardcoded `Bun.spawn` inside `drain()`. This keeps `drain()` unit-testable with a fake skill + in-memory body, and is where `server.ts` wires the real `gh`/`git`/`bun run verify` calls (Task 6). It also keeps the human-box and auto-box paths sharing one spawn helper.

- [ ] **Step 3: Write the fake-skill fixture** `tests/fixtures/fake-skill.ts` — it ONLY edits a file + nothing else (NO gate run, NO commit, NO signal). The runner gates it. Two modes via an env flag so a test can drive a red gate:

```typescript
// tests/fixtures/fake-skill.ts — pretends to be a drainable skill (vc).
// It ONLY edits a file in CWD (the worktree) + writes body.html (presentation).
// It does NOT run the gate, check a box, commit, or write any signal. The RUNNER
// runs the gate after this exits — proving the runner-owned-gate architecture.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const uuid = process.env.VOID_OS_SESSION!;
const vault = process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");
mkdirSync(join(vault, "sessions", uuid), { recursive: true });
writeFileSync(join(vault, "sessions", uuid, "body.html"), "<h1>fake skill worked a box</h1>");
// Make a real edit in CWD (the worktree) — the runner will `git add -A && commit` it on a green gate.
writeFileSync(join(process.cwd(), `box-${uuid}.txt`), "work output");
```

- [ ] **Step 4: Write `tests/drain.test.ts`** covering the v2 tests. Use a real git repo as the worktree, point `runner` at `bun <dir>/fixtures/fake-skill.ts --`, and inject the gate/body/commit callbacks. Required cases:

  1. **`tailProgress`** unit (tail-only; since-last-`DONE:`; empty → `(empty)`).
  2. **runner-runs-the-auto-check (fake only edits; runner gates).** `runGate` returns 0; assert the runner called `runGate` AFTER the spawn, then `writeBody` (box now `- [x]`) + `commit`. The fake never touched the box — proves the runner owns the gate + write.
  3. **multi-iteration PROGRESS loop.** A `fetchBody` that returns 2 open boxes, flipping the just-checked one to `- [x]` after each `writeBody`; assert `iterations === 2` and final `status === "complete"`.
  4. **cwd≠vault split.** Worktree = a real git repo distinct from `vault`; after a green box assert (a) the runner's `commit` callback ran in the worktree (a new commit / the `box-*.txt` file tracked) and (b) `bodyPath(vault, uuid)` is readable under the vault, and `vault/.git` does NOT exist.
  5. **human-park.** A single `{human}` box; assert `status === "parked-human"`, a `parkedUuid` is returned, and that session's `session-meta.json` carries `{skill, drainIssue, worktree, max}`.
  6. **red-after-N → terminal `failed` (no loop-to-max).** `runGate` always returns 1; assert `status === "failed"`, `failedBox` set, `iterations === 1` (NOT `max`), a `FAILED:` line is in `progress.txt`, and `writeBody` was NEVER called (the box stays unchecked). This is the red-blocks regression guard.
  7. **idempotent re-run skips checked.** `fetchBody` returns a body whose only box is already `- [x]`; assert `status === "complete"`, ZERO spawns, ZERO `writeBody`/`commit` calls.
  8. **dirty-worktree guard.** Leave an untracked stray file in the worktree; assert `status === "dirty-worktree"` and NO spawn happened.

  (Inject `runGate`/`writeBody`/`commit`/`commentDrained` as test spies so the assertions above are observable without real `gh`/`git` mutations, except the worktree git ops in case 4 which use a real tmp repo.)

- [ ] **Step 5: `bun test tests/drain.test.ts`** → PASS (all 8 cases).
- [ ] **Step 6: Commit** — `git add src/spawn.ts src/drain.ts tests/drain.test.ts tests/fixtures/fake-skill.ts && git commit -m "feat(drain): runner-owned gated loop — runner runs the gate, skill param, auto red→N→failed, human-park, idempotent comment-complete"`

---

## Task 6: Server `POST /drain` route + `/send` resume + agent-inbox

**Files:** modify `src/server.ts` (add `POST /drain`; extend `POST /s/:uuid/send`); modify `src/render.ts` (inbox panel); test `tests/server.test.ts` (extend the existing `mock.module` for spawn).

The human-gate verdict path REUSES `POST /s/:uuid/send`. The parked session's `body.html` holds the skill's `<form>` (so `listSessions` shows it `awaiting`). When the operator submits a verdict, the handler must resume the skill **in the worktree** then re-invoke `drain()`.

- [ ] **Step 1: Add a drain-options builder + `POST /drain` route.** Extract a `drainOptsFor(vault, issueNum, worktree, runner, max)` returning a `DrainOpts` whose callbacks shell out to real tools, so `/drain` and the `/send` resume share ONE definition:

```typescript
import { drain, type DrainOpts } from "./drain.ts";
import { homedir } from "node:os";

function drainOptsFor(vault: string, issueNum: number, worktree: string, runner: string, max: number): DrainOpts {
  const sh = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  };
  return {
    vault, worktree, issueNum, runner, skill: "ralph", max,
    fetchBody: async () => (await sh(["gh", "issue", "view", String(issueNum), "--json", "body", "-q", ".body"])).out.trim(),
    writeBody: async (body) => {
      const p = Bun.spawn(["gh", "issue", "edit", String(issueNum), "--body-file", "-"], { cwd: worktree, stdin: "pipe" });
      p.stdin.write(body); p.stdin.end(); await p.exited;
    },
    runGate: async (check) => (await Bun.spawn(["bash", "-lc", check], { cwd: worktree, stdout: "ignore", stderr: "ignore" }).exited),
    commit: async (message) => { await sh(["git", "add", "-A"]); await sh(["git", "commit", "-m", message]); },
    commentDrained: async () => {
      const branch = `ralph/issue-${issueNum}`;
      await sh(["gh", "issue", "comment", String(issueNum), "--body",
        `Drained locally on \`${branch}\`, unpushed (no-push PoC posture). All boxes checked; commits live in the worktree only.`]);
    },
  };
}

// POST /drain — kick off an Issue-drain in a pre-created worktree. Fire-and-forget.
app.post("/drain", async (c) => {
  const body = await c.req.parseBody();
  const issueNum = parseInt(String(body.issue ?? ""), 10);
  if (!Number.isFinite(issueNum)) return c.text("bad issue number", 400);
  const worktree = join(homedir(), "void-os-wt", `issue-${issueNum}`);
  if (!existsSync(worktree)) return c.text(`worktree ${worktree} does not exist — create it first`, 412);
  const runner = resolveRunner(readConfig(vault));
  const max = Number(body.max ?? 12);
  void drain(drainOptsFor(vault, issueNum, worktree, runner, max)); // long-running; observe via session list
  return c.redirect("/");
});
```

- [ ] **Step 1b: Resume a parked drain from `POST /s/:uuid/send` ([P2-#1 BLOCKER], v2 form).** The existing handler resumes via `spawnTurn(cwd=vault)` — WRONG for a drain (the resumed agent's edits would have no repo). For a drain session, resume via `runTurn(cwd=worktree)` then re-invoke `drain()`:

```typescript
// inside app.post("/s/:uuid/send", ...): after building `text` + recovering `runnerCommand`,
// detect a parked drain BEFORE the generic spawnTurn, and branch.
const meta = existsSync(metaPath)
  ? (JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string; drainIssue?: number; worktree?: string; max?: number })
  : {};
if (typeof meta.drainIssue === "number" && meta.worktree) {
  // Resume the parked skill IN THE WORKTREE so its edits land in the repo, then continue the loop.
  await runTurn(meta.worktree, vault, uuid, buildAnswerArgv(uuid, text), runnerCommand);
  setTimeout(() => {
    void drain(drainOptsFor(vault, meta.drainIssue!, meta.worktree!, runnerCommand, meta.max ?? 12));
  }, 500); // brief gap so the resumed agent's edits settle before the continuation re-fetches
  return c.html(workingPage(fields));
}
// ...else fall through to the existing non-drain spawnTurn path (unchanged).
```

Notes: import `runTurn` from `./spawn.ts`. The continuation `drain()` re-fetches + skips already-checked boxes (idempotent), so it checks the just-resolved human box (the runner does the checkbox write now, NOT the agent — the resumed skill only re-rendered `body.html` without a `<form>`, the runner detects the gate is human and… **see caveat below**), then picks the next open box.

> **Caveat the implementer MUST resolve (human-box completion path).** In v2 the runner parks on a human box BEFORE running any gate, and the human gate has no machine check. So the continuation `drain()` re-fetches and sees the SAME human box still `- [ ]` → it would park AGAIN, never checking it. The resume must therefore mark the human box passed. Two viable wirings — pick one in Task 5/6 and test it:
> - **(A) verdict-aware drain:** `drainOptsFor` for the resume path passes a flag (e.g. `resolveHumanUuid: uuid`) so the continuation, on encountering the parked human box, treats `verdict: accept` as the pass: it does the `checkBox` write + `commit` for that box (NOT re-spawn), then loops. (Preferred — keeps the checkbox write runner-owned.)
> - **(B) resume-then-recompute:** the resumed skill, on `accept`, itself flips its box via `gh` (a deliberate exception to "skill never writes checkboxes", scoped to the human-accept case); the continuation drain then sees it `- [x]` and moves on.
> **Decision: implement (A)** — it preserves the runner-owned-write invariant. Add a `humanAccept?: Box["raw"]` (or the parked uuid + a lookup) to the resume `drain()` call and a `tests/drain.test.ts` case: park on human → re-invoke drain with the accept signal → that box gets `writeBody`+`commit` (runner-owned) without a re-spawn → next box proceeds → `complete`. This is the human-park→verdict→resume→drain-re-invoked→completes test the spec requires.

- [ ] **Step 2: Agent-inbox panel** in `renderDashboard` — list sessions where `status === "awaiting"` (and, if cheap, `skill === "ralph"`); each row links to `/s/<uuid>` where the operator sees the artifact + the skill-rendered accept/edit/feedback form. Title "Agent inbox — pending verdicts"; empty-state line when none. Match existing `renderDashboard` markup.
- [ ] **Step 3: Server tests** in `tests/server.test.ts` (extend the existing `mock.module("../src/spawn.ts", …)` to also stub **`runTurn`** into a `runTurnCalls` array):
  - `POST /drain` with a non-existent worktree → 412.
  - `renderDashboard` output contains "Agent inbox" + lists a seeded awaiting session.
  - **[BLOCKER regression] `POST /s/:uuid/send` on a parked drain calls `runTurn` with `cwd === worktree`** (assert from `runTurnCalls`) and triggers a continuation `drain()`. Seed `session-meta.json` `{skill:"ralph", drainIssue:N, worktree:<tmp>, max:3}`; POST `verdict: accept`; assert `runTurn` ran with the worktree cwd (NOT vault) and the continuation reached the next box / `complete`.
- [ ] **Step 4: `bun run verify`** → `VERIFY GREEN`.
- [ ] **Step 5: Commit** — `git add src/server.ts src/render.ts tests/server.test.ts && git commit -m "feat(drain): POST /drain + worktree-resume on /send verdict + dashboard agent-inbox"`

---

## Task 7: Update the glossary + ADR to runner-owned + skill-decoupled (VAULT — hub master)

**Files (VAULT repo, committed direct to hub master — NOT void-os):**
- `vault/projects/void-os/CONTEXT.md`
- `vault/projects/void-os/adr/0001-ralph-gated-loop.md`

These currently encode the SUPERSEDED "agent self-selects / Runner does not assign" model. Flip them to v2 and add the skill-decoupled seam. This task is doc-only and lands on hub master (the planner already commits the task file there; the implementer commits these two there too — `sw`-scope or direct, NOT via the void-os branch).

- [ ] **Step 1: CONTEXT.md `### Runner`** — replace "lets the agent self-select one Box … The Runner does **not** assign Boxes — the agent self-selects the highest-priority open one each iteration" with the v2 ownership: *the Runner parses the Issue, **assigns** the highest-priority open Box, spawns a fresh Session to work ONLY that Box, then **runs the Box's gate itself** (auto: runs the check + reads the exit code; human: parks), and on a green gate does the checkbox write + commit. The Session does only the work.*
- [ ] **Step 2: CONTEXT.md `### Session` gated-loop note** — change "the Runner does not assign Boxes — the agent self-selects" to "the Runner assigns the Box; the Session works only it."
- [ ] **Step 3: CONTEXT.md — add a `### Skill (drainable)` note (or extend `### Skill`)** capturing Decision B: the drain loop is generic; a **skill** is a parameter (`drain(issueNum, {skill})`); `ralph` is the first drainable skill; the loop never hardcodes it; NO skill registry in the PoC.
- [ ] **Step 4: ADR-0001 §4 + sub-decision (a)/(d)** — amend the Decision to runner-owned gates: the agent does NOT self-select or self-report; the Runner assigns the Box and runs the gate (auto exit-code, human-park-from-annotation, completion-from-allChecked). Note this REVISES the original "(the Runner does not assign)" line (line 51–52) and the "on pass, checks the Box and commits" actor (now the Runner, not the agent). Add a short "**Amendment 2026-05-31 (v2): runner-owned gates + skill-decoupled orchestration**" subsection rather than silently rewriting history — record WHY (two forge passes traced nearly every finding to the runner↔agent self-report contract). Add the skill-as-parameter seam (Decision B) + the YAGNI scope guard.
- [ ] **Step 5: Commit on hub master** — `git add vault/projects/void-os/CONTEXT.md vault/projects/void-os/adr/0001-ralph-gated-loop.md && git commit -m "canon(void-os): v2 amendment — runner-owned gates + skill-decoupled drain loop"` (NOT pushed by the implementer; orchestrator controls push).

---

## Task 8: Author the first real dogfood Issue + run the end-to-end drain

**Acceptance phase. Runs REAL `vc` sessions + mutates a REAL GitHub Issue. NO push to `main` — commits accumulate on a branch in the worktree.**

**Chosen first dogfood feature:** *"Drain-run status surface"* — make the dashboard show, per ralph drain, how many boxes are checked vs total for its Issue. Small, self-contained, true dogfood (uses `drainProgress` from Task 4), yields ≥2 auto + ≥1 human box.

**Box breakdown (confirmed):**
1. `- [ ] Wire drainProgress into a "Drain N/M boxes" badge data path {auto: bun run verify} {p1}` — uses the `drainProgress` from Task 4; unit/server test asserts the count.
2. `- [ ] Render the "Drain N/M boxes" badge per ralph session on the dashboard {auto: bun run verify} {p2}` — server test asserts the badge text renders.
3. `- [ ] Polish the badge empty/complete-state copy + color {human} {p3}` — human gate: skill renders a preview into `body.html`; operator accepts.

- [ ] **Step 1: Create the Issue first, then the worktree** (so the dir/branch match the real number):
  ```bash
  gh issue create --repo makscee/void-os --title "Drain-run status surface" --body "$(cat <<'EOF'
Dogfood Issue for the gated drain-loop PoC. Schema: docs/ralph/issue-schema.md

- [ ] Wire drainProgress into a "Drain N/M boxes" badge data path {auto: bun run verify} {p1}
      Use drainProgress(body) from src/issue.ts. Unit/server test asserts the count.
- [ ] Render the "Drain N/M boxes" badge per ralph session on the dashboard {auto: bun run verify} {p2}
      Server test asserts the badge renders "N/M boxes".
- [ ] Polish the badge empty/complete-state copy + color {human} {p3}
      Skill renders a preview to body.html; human accepts the tone/color.
EOF
)"
  ```
  Record `<NUM>`, then: `git -C /Users/admin/hub/workspace/void-os worktree add ~/void-os-wt/issue-<NUM> -b ralph/issue-<NUM> main`.
- [ ] **Step 2: Run the drain end-to-end.** Start the server (`bun run serve`), open the dashboard, `POST /drain` with `issue=<NUM>`. Watch: box #1 (auto) — skill edits → **runner runs `bun run verify`** green → runner checks box + commits; box #2 (auto) likewise; box #3 (human) — skill renders preview + `<form>` → runner parks → inbox shows it → operator submits `verdict: accept` → `/send` resumes via `runTurn(cwd=worktree)` → continuation `drain()` (verdict-aware path A) checks the human box + commits → `allChecked` → `gh issue comment "drained locally, unpushed"`, Issue OPEN.
- [ ] **Step 3: Red-blocks proof.** On a SCRATCH Issue (or a deliberately-failing extra auto box), give an `auto` box a check that cannot pass on the first try. Confirm in `run-N.log` + `progress.txt`: the box is NOT checked while red, the runner re-spawns ≤3 times (RETRY lines), then a `FAILED:` line lands and the drain ends `failed` (does NOT loop to MAX). Capture as evidence. (This exercises the Task-5 case-6 path in the real loop.)
- [ ] **Step 4: Capture evidence (real-path):**
  - `~/.void-os/sessions/<uuid>/run-*.log` per box.
  - `git -C ~/void-os-wt/issue-<NUM> log --oneline` — one commit per box, in the WORKTREE (proves the cwd/vault split).
  - `~/void-os-wt/issue-<NUM>/progress.txt` showing DONE/RETRY/FAILED lines (copy it aside DURING the run — it is deleted on complete).
  - Playwright/manual screenshot of the agent-inbox: human box pending, then resolved.
  - `gh issue view <NUM>` — all boxes `- [x]`, Issue **OPEN**, "drained locally … unpushed" comment present.
- [ ] **Step 5: Idempotency + safe-completion proof.** After ≥1 box is checked, kill the drain (or let MAX trip on a scratch Issue) and re-`POST /drain`. Confirm: re-run SKIPS already-checked boxes (no duplicate commits); the drained-comment appears ONLY after `allChecked(refetched)`; `progress.txt` exists mid-drain and is gone only after complete.
- [ ] **Step 6: cache_control verification.** Capture ONE of: an outbound Anthropic request body from the drain showing a `cache_control` block on the stable prefix (via relay request log, or `LOG_RAW_API_PAYLOADS` on void-fcc TEMPORARILY then disable + purge per [[feedback_fcc_raw_payload_logging_privacy]]); OR a usage record from an iteration ≥2 turn showing `cache_read_input_tokens > 0`. If NEITHER is observable, that is a FINDING (relay may be stripping it) — surface it, do not silently pass T8.
- [ ] **Step 7: Confirm NO push.** `git -C ~/void-os-wt/issue-<NUM> log origin/main..HEAD --oneline` (shows unpushed commits); `git -C ~/void-os-wt/issue-<NUM> status` (ahead of origin, not pushed). Do NOT `git push`.
- [ ] **Step 8: Final verify on the branch.** In the worktree: `bun run verify` → `VERIFY GREEN`.

---

## Self-Review

- **Spec coverage (every `## Done when` bullet → a task):**
  - single `verify` command → T1.
  - `catalog/skills/ralph/SKILL.md` launchable + Inputs/Process/Outputs, self-documenting → T3.
  - Issue/story schema documented → T2.
  - server-side drain runner, fresh session per box, MAX backstop, completion + park → T5 (now runner-owned; the "agent self-selects / early-exit on PROMISE COMPLETE HERE / park on NEEDS HUMAN" wording in the Done-when bullets is SUPERSEDED by v2 — the runner selects + derives completion + parks-from-annotation; same outcomes, different ownership. The bullets describe behavior, which holds).
  - `auto` gate red → bounded recovery → exhausted → record + end iter; green → check + commit → T5 (runner runs the gate; red→N→`failed`).
  - `human` gate → inbox → verdict via `POST /s/:uuid/send` → check + commit → T5 (park) + T6 (resume via `runTurn(cwd=worktree)` + verdict-aware continuation, path A).
  - real drain ≥2 auto + ≥1 human, boxes checked, commit per box, progress appended, Issue closed-at-end → T8 (Issue left OPEN + commented per the v2 comment-not-close decision — the "closed" wording in the Done-when bullet is SUPERSEDED by pass-2 #2).
  - red-blocks proof → T5 case 6 + T8 step 3.
  - no push → T8 step 7.
  - evidence (real-path) → T8 step 4 (+ 5/6).
- **Sequencing:** P1→P2→P3 strictly sequential; within P3 T4→T5→T6; T7 documents the as-built loop; P5 needs P1–P3. No false dependencies — T7 is doc-only and could run earlier but is placed to reflect the as-built loop.
- **Shippability:** each phase lands a self-contained, tested unit; no half-broken intermediate.
- **Scope discipline:** runner-owned gates + skill-as-parameter ONLY. NO skill registry / selection UX / per-skill config (Decision B YAGNI). NO `signal.txt`/`classifyOutcome` (deferred). NO MCP, NO prd.json, NO merge-gate, NO AFK/eval layer.
- **Premise check (all re-verified against the repo 2026-05-31):** `spawnTurn` fire-and-forget cwd=vault → new awaitable `runTurn(cwd,…)`; `/s/:uuid/send` recovers only `runner` → extended to recover drain ctx + resume via worktree; `deriveStatus` keys `<form` → human-park writes `<form>`; `session-meta.json` shape → extended; `server.test.ts` mocks `src/spawn.ts` → the new server test extends that mock to stub `runTurn`; canon docs live in the VAULT not the repo → T7 targets the vault. The one genuine wrinkle surfaced + resolved in-plan: the **human-box completion path** (runner parks before any gate, human gate has no machine check, so the continuation would re-park forever) → resolved by the verdict-aware path (A) with a dedicated test.
