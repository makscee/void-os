# VOS-107 — Full e2e Playwright + manual UI/UX pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `vos-v1-router` milestone closer — full Playwright e2e suite (audit existing + fill gaps + fix broken) committed green, plus a structured manual UI/UX feedback pass with follow-up tasks filed for any blocker-grade friction.

**Architecture:** Phase-gated. Phase 1: smoke baseline of 7 existing specs. Phase 2: parallel build (1 AUDIT + 1 FIX + 5 NEW specs). Phase 3: full green run. Phase 4: operator-driven manual UI/UX pass against generated checklist. Each phase has explicit gate criteria; Phase 2 only dispatches if Phase 1 baseline is clean (or flake-bounded).

**Tech Stack:** Playwright Electron, Bun (daemon), TypeScript, fake-cc fixtures (jsonl). All work inside `~/hub-wt/VOS-107/workspace/void-os/`. Spec doc: `docs/superpowers/specs/2026-05-17-VOS-107-full-e2e-and-manual-uiux-pass-design.md`.

---

## File Map

| Path | Action |
|---|---|
| `plugin/e2e/specs/connect.spec.ts` | audit, expand thin assertions |
| `plugin/e2e/specs/chat-roundtrip.spec.ts` | audit |
| `plugin/e2e/specs/chat-list-polish.spec.ts` | audit — assert INPUT_REQUIRED pill + cost column |
| `plugin/e2e/specs/ask-agent.spec.ts` | audit |
| `plugin/e2e/specs/ask-agent-subthread.spec.ts` | audit |
| `plugin/e2e/specs/ask-agent-nested.spec.ts` | audit |
| `plugin/e2e/specs/ask-agent-reload.spec.ts` | audit |
| `plugin/e2e/specs/ask-user.spec.ts` | **fix** — see Task 9 |
| `plugin/e2e/fixtures/ask-user.jsonl` | **new** fixture file (does NOT replace `maya.jsonl`) |
| `plugin/e2e/specs/agent-picker.spec.ts` | **new** |
| `plugin/e2e/specs/cost-meter.spec.ts` | **new** |
| `plugin/e2e/specs/starter-agents.spec.ts` | **new** |
| `plugin/e2e/specs/permission-deny.spec.ts` | **new** (daemon HTTP) |
| `plugin/e2e/specs/permission-deny-ui.spec.ts` | **new** (UI surface) |
| `vault/work/tasks/active/VOS-107-manual-uiux-notes.md` | **new** state-plane manual checklist, sw-committed |

---

## Conventions every subagent follows

- Worktree root: `/Users/admin/hub-wt/VOS-107/workspace/void-os/`. Branch: `task/VOS-107`. Never push.
- Run specs via: `cd plugin && bun e2e -- <spec-name>` (single spec) or `bun e2e` (suite). `workers: 1` is already set.
- REST drive (when picker not under test): `request.post('/chats')` + `request.post('/chat/:id/message')`. Save Playwright clicks for what the spec actually asserts.
- Fixture mutation only in `beforeEach`/`afterEach`; restore from a snapshot taken in `beforeAll`.
- Daemon `idleTimeout: 255` is in `plugin/daemon/src/server.ts` — preserve.
- Emit ≥1 assistant text turn before any `vos_ask_user` to defeat ChatList `isEmpty` filter.
- `git add` scope: per-spec path only. Never `git add -A` (per hub feedback `parallel_agents_git_add_hygiene`).
- Each task commits on `task/VOS-107` inside the worktree.

---

## Phase 1 — Baseline smoke

### Task 1: Run baseline e2e suite

**Files:** none modified. Output captured to Work Log.

- [ ] **Step 1: Run the 7 baseline specs with retries**

```bash
cd /Users/admin/hub-wt/VOS-107/workspace/void-os/plugin
bun e2e -- --retries=2 \
  specs/connect.spec.ts \
  specs/chat-roundtrip.spec.ts \
  specs/chat-list-polish.spec.ts \
  specs/ask-agent.spec.ts \
  specs/ask-agent-subthread.spec.ts \
  specs/ask-agent-nested.spec.ts \
  specs/ask-agent-reload.spec.ts \
  2>&1 | tee /tmp/VOS-107-baseline.log
```

Expected: all 7 pass on first attempt. `ask-user.spec.ts` is **excluded** (known broken).

- [ ] **Step 2: Classify result per spec**

For each spec:
- pass on attempt 1 → "green"
- pass on attempt 2 or 3 → "flake" (note in step 3)
- fail 3/3 → "red"

- [ ] **Step 3: Record baseline SHA + summary in Work Log**

Via `sw`:
```bash
cd /Users/admin/hub && tools/state-write/sw "task(VOS-107): baseline" -- bash -c '
set -e
cd /Users/admin/hub
f=$(ls vault/work/tasks/active/VOS-107-*.md | head -1)
sha=$(cd /Users/admin/hub-wt/VOS-107/workspace/void-os && git rev-parse HEAD)
cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · phase 1 baseline
- baseline SHA: $sha
- result: <green | green-with-flake | red>
- per-spec: <table or list>
EOF
git add "$f"
'
```

- [ ] **Step 4: Gate decision**

- baseline all-green or only-flake-2-of-3 → proceed to Phase 2
- ≥1 spec red 3/3 → stabilise that spec first (separate surgical commit), re-run, then proceed

---

## Phase 2 — Build (parallel subagents)

Dispatch all 7 streams below in a single parallel batch via `superpowers:dispatching-parallel-agents`. Each stream is one subagent. Streams are independent at file level after the FIX/fixture isolation.

### Task 2: AUDIT — connect.spec.ts

**Files:**
- Modify: `plugin/e2e/specs/connect.spec.ts`

- [ ] **Step 1: Re-read spec; list assertions against surface "daemon connection"**

Check: connect flow renders connected state; daemon URL persisted; reconnect on daemon restart (if covered by milestone).

- [ ] **Step 2: For each missing/thin assertion, add concrete check**

If spec only asserts "connected dot visible", add:
```ts
await expect(page.getByTestId("daemon-url")).toHaveText(`http://127.0.0.1:${state.port}`);
```

- [ ] **Step 3: Run spec**

```bash
cd plugin && bun e2e -- specs/connect.spec.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add plugin/e2e/specs/connect.spec.ts
git commit -m "test(VOS-107): audit connect.spec — expand daemon-url assertions"
```

### Task 3: AUDIT — chat-roundtrip.spec.ts

**Files:**
- Modify: `plugin/e2e/specs/chat-roundtrip.spec.ts`

- [ ] **Step 1: Verify surface S0 (`TASK_STATE_INPUT_REQUIRED`) coverage**

Spec must assert: task state transitions WORKING → COMPLETED end-to-end, assistant turn rendered, chat row updated.

- [ ] **Step 2: Add state assertion if missing**

Subscribe to `/events` and assert state sequence via:
```ts
const states = await collectStatesFor(taskId, page);
expect(states).toContain("WORKING");
expect(states.at(-1)).toBe("COMPLETED");
```

- [ ] **Step 3: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/chat-roundtrip.spec.ts
git add plugin/e2e/specs/chat-roundtrip.spec.ts
git commit -m "test(VOS-107): audit chat-roundtrip — assert task state sequence"
```

### Task 4: AUDIT — chat-list-polish.spec.ts (surface S4)

**Files:**
- Modify: `plugin/e2e/specs/chat-list-polish.spec.ts`

- [ ] **Step 1: Verify INPUT_REQUIRED indicator assertion**

Spec must drive a chat into INPUT_REQUIRED (via fixture emitting `vos_ask_user`) and assert the row pill renders.

- [ ] **Step 2: Verify cost column assertion**

Spec must assert chat row cost cell renders a non-empty value after assistant turn.

- [ ] **Step 3: If thin, expand:**

```ts
await expect(row.getByTestId("input-required-pill")).toBeVisible();
await expect(row.getByTestId("cost-cell")).not.toHaveText("");
```

- [ ] **Step 4: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/chat-list-polish.spec.ts
git add plugin/e2e/specs/chat-list-polish.spec.ts
git commit -m "test(VOS-107): audit chat-list-polish — assert pill + cost cell"
```

### Task 5: AUDIT — ask-agent.spec.ts (surface S3)

**Files:**
- Modify: `plugin/e2e/specs/ask-agent.spec.ts`

- [ ] **Step 1: Re-read; confirm state machine assertions (parent WAITING_ON_AGENT, child COMPLETED, parent resumes)**

Existing comment already lists these. Verify the test bodies match the comment.

- [ ] **Step 2: If gap, expand to match comment.**

- [ ] **Step 3: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/ask-agent.spec.ts
git add plugin/e2e/specs/ask-agent.spec.ts
git commit -m "test(VOS-107): audit ask-agent.spec — verify state sequence assertions"
```

### Task 6: AUDIT — ask-agent-subthread.spec.ts

**Files:**
- Modify: `plugin/e2e/specs/ask-agent-subthread.spec.ts`

- [ ] **Step 1: Verify sub-thread collapsible UI assertion**

Spec must assert child turns render under a collapsible group attached to the parent's tool_use turn.

- [ ] **Step 2: Add toggle assertion if missing**

```ts
const subthread = parentTurn.getByTestId("subthread-group");
await expect(subthread).toBeVisible();
await subthread.getByRole("button", { name: /collapse|expand/i }).click();
await expect(subthread.locator(".subthread-body")).toBeHidden();
```

- [ ] **Step 3: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/ask-agent-subthread.spec.ts
git add plugin/e2e/specs/ask-agent-subthread.spec.ts
git commit -m "test(VOS-107): audit ask-agent-subthread — assert collapsible toggle"
```

### Task 7: AUDIT — ask-agent-nested.spec.ts

**Files:**
- Modify: `plugin/e2e/specs/ask-agent-nested.spec.ts`

- [ ] **Step 1: Verify depth-2 nesting renders**

Spec must assert depth-2 child (`deep` agent) appears nested under `journaler` which is nested under `maya`.

- [ ] **Step 2: Add depth assertion if missing**

```ts
const depthLevels = await page.locator("[data-subthread-depth]").evaluateAll(
  (els) => els.map((e) => Number(e.getAttribute("data-subthread-depth")))
);
expect(Math.max(...depthLevels)).toBeGreaterThanOrEqual(2);
```

- [ ] **Step 3: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/ask-agent-nested.spec.ts
git add plugin/e2e/specs/ask-agent-nested.spec.ts
git commit -m "test(VOS-107): audit ask-agent-nested — assert depth-2"
```

### Task 8: AUDIT — ask-agent-reload.spec.ts

**Files:**
- Modify: `plugin/e2e/specs/ask-agent-reload.spec.ts`

- [ ] **Step 1: Verify reload persistence**

Spec must trigger an ask_agent flow, reload the plugin, assert sub-thread structure survives reload from daemon state.

- [ ] **Step 2: Add reload assertion if missing**

```ts
await page.reload();
await expect(parentTurn.getByTestId("subthread-group")).toBeVisible();
```

- [ ] **Step 3: Run spec + commit**

```bash
cd plugin && bun e2e -- specs/ask-agent-reload.spec.ts
git add plugin/e2e/specs/ask-agent-reload.spec.ts
git commit -m "test(VOS-107): audit ask-agent-reload — assert subthread persists across reload"
```

### Task 9: FIX — ask-user.spec.ts (surface S2)

**Files:**
- Create: `plugin/e2e/fixtures/ask-user.jsonl`
- Modify: `plugin/e2e/specs/ask-user.spec.ts`
- **DO NOT MODIFY:** `plugin/e2e/fixtures/ask-agent/maya.jsonl` (any commit touching this file from this task is a bug)

- [ ] **Step 1: Write the dedicated fixture**

Create `plugin/e2e/fixtures/ask-user.jsonl` with this content:

```jsonl
{"type":"system","subtype":"init","session_id":"e2e-ask-user"}
{"type":"assistant","message":{"content":[{"type":"text","text":"thinking…"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"vos_ask_user","input":{"prompt":"pick one","options":["A","B"]}}]}}
```

The leading text turn ("thinking…") prevents the ChatList `isEmpty` filter from hiding the row.

- [ ] **Step 2: Wire the spec to use the new fixture**

Implementation options (pick the one that works first; document the chosen one in a header comment):

Option A — Playwright project entry:
Add a new project to `plugin/e2e/playwright.config.ts` for the ask-user spec that launches its own daemon with `VOS_FAKE_SCRIPT_maya` pointing at `fixtures/ask-user.jsonl`.

Option B — test-scoped daemon fixture:
Use a `test.beforeAll` hook in the spec that spawns a second daemon worker with the overridden env, points the plugin at that daemon's port, restores in `afterAll`.

Option C — fallback: temporary env swap:
In `beforeAll`, set `process.env.VOS_FAKE_SCRIPT_maya` to the ask-user fixture path and POST `/admin/reload-fake-script` if the daemon exposes one. If it does not, raise and fall through to Option A or B.

**Hard rule:** the spec never edits `maya.jsonl` file contents. Restoration from `git show :path` is not needed because nothing was modified.

- [ ] **Step 3: Spec body**

```ts
import { test, expect } from "@playwright/test";

test("ask_user inline render + option click + state clears", async ({ request }) => {
  const state = readE2EState();
  const { id: chatId } = await (await request.post(`http://127.0.0.1:${state.port}/chats`, {
    data: { agent_name: "maya" },
  })).json();

  await request.post(`http://127.0.0.1:${state.port}/chat/${chatId}/message`, {
    data: { content: "go" },
  });

  // wait for INPUT_REQUIRED
  await waitForState(chatId, "TASK_STATE_INPUT_REQUIRED", state.port);

  const { page } = await getVaultPage(state.cdpPort);
  await openChat(page, chatId);

  const askUser = page.getByTestId("ask-user-turn");
  await expect(askUser).toBeVisible();
  await expect(askUser.getByRole("button", { name: "A" })).toBeVisible();
  await expect(askUser.getByRole("button", { name: "B" })).toBeVisible();

  await askUser.getByRole("button", { name: "A" }).click();

  await waitForStateNotEqual(chatId, "TASK_STATE_INPUT_REQUIRED", state.port);
});
```

- [ ] **Step 4: Run spec**

```bash
cd plugin && bun e2e -- specs/ask-user.spec.ts
```
Expected: PASS. If FAIL with daemon-spawn issue → fall through to next option (A → B → C).

- [ ] **Step 5: Verify no maya.jsonl change**

```bash
git status plugin/e2e/fixtures/ask-agent/maya.jsonl
```
Expected: clean (no modification staged or unstaged).

- [ ] **Step 6: Commit**

```bash
git add plugin/e2e/specs/ask-user.spec.ts plugin/e2e/fixtures/ask-user.jsonl plugin/e2e/playwright.config.ts
git commit -m "test(VOS-107): fix ask-user.spec — dedicated fixture, no maya.jsonl mutation"
```

### Task 10: NEW — agent-picker.spec.ts (surface S1)

**Files:**
- Create: `plugin/e2e/specs/agent-picker.spec.ts`

- [ ] **Step 1: Read starter manifest**

```bash
ls /Users/admin/hub-wt/VOS-107/workspace/void-os/starter-vault/
grep -rn 'agent\|starter' plugin/daemon/src/agents/ plugin/daemon/src/starter/ 2>/dev/null | head -20
```

Determine the list of starter agents and the daemon route that exposes them. Cite findings in spec header comment.

- [ ] **Step 2: Write spec**

```ts
import { test, expect } from "@playwright/test";

test("agent picker opens, lists starter agents, records selection", async () => {
  const state = readE2EState();
  const { page } = await getVaultPage(state.cdpPort);

  await page.getByTestId("new-chat-button").click();

  const picker = page.getByTestId("agent-picker-modal");
  await expect(picker).toBeVisible();

  const options = picker.getByRole("button");
  const count = await options.count();
  expect(count).toBeGreaterThanOrEqual(2);

  await options.first().click();
  await expect(picker).toBeHidden();

  // assert chat created with agent_name recorded
  const chats = await (await page.request.get(`http://127.0.0.1:${state.port}/chats`)).json();
  expect(chats.at(-1).agent_name).toBeTruthy();
});
```

- [ ] **Step 3: Run + iterate until pass**

```bash
cd plugin && bun e2e -- specs/agent-picker.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add plugin/e2e/specs/agent-picker.spec.ts
git commit -m "test(VOS-107): new agent-picker.spec — modal opens, lists agents, records selection"
```

### Task 11: NEW — cost-meter.spec.ts (surface S5)

**Files:**
- Create: `plugin/e2e/specs/cost-meter.spec.ts`

- [ ] **Step 1: Locate cost surfacing in daemon + plugin**

```bash
grep -rn 'cost\|usage\|tokens' plugin/daemon/src/ plugin/src/ 2>/dev/null | head -30
```
Cite resolved cost field name + route in header comment.

- [ ] **Step 2: Write spec**

```ts
test("cost meter increments per-task and rolls up per-day", async ({ request }) => {
  const state = readE2EState();
  const { id: chatId } = await (await request.post(`http://127.0.0.1:${state.port}/chats`, {
    data: { agent_name: "maya" },
  })).json();

  // First message
  await request.post(`http://127.0.0.1:${state.port}/chat/${chatId}/message`, {
    data: { content: "one" },
  });
  await waitForState(chatId, "TASK_STATE_COMPLETED", state.port);
  const cost1 = (await (await request.get(`http://127.0.0.1:${state.port}/chats`)).json())
    .find((c: any) => c.id === chatId).cost;
  expect(cost1).toBeGreaterThan(0);

  // Second message
  await request.post(`http://127.0.0.1:${state.port}/chat/${chatId}/message`, {
    data: { content: "two" },
  });
  await waitForState(chatId, "TASK_STATE_COMPLETED", state.port);
  const cost2 = (await (await request.get(`http://127.0.0.1:${state.port}/chats`)).json())
    .find((c: any) => c.id === chatId).cost;
  expect(cost2).toBeGreaterThan(cost1);

  // Header per-day total in UI
  const { page } = await getVaultPage(state.cdpPort);
  await expect(page.getByTestId("daily-cost")).toContainText(/\d/);
});
```

Per-day reset assertion: if the daemon supports a clock-injection env (`VOS_FAKE_NOW`), use it to insert an older chat. If not, document the limitation in header and skip that bullet (still acceptable per spec — it's a stretch acceptance, not a hard one).

- [ ] **Step 3: Run + iterate + commit**

```bash
cd plugin && bun e2e -- specs/cost-meter.spec.ts
git add plugin/e2e/specs/cost-meter.spec.ts
git commit -m "test(VOS-107): new cost-meter.spec — per-task increment + per-day surface"
```

### Task 12: NEW — starter-agents.spec.ts (surface S6)

**Files:**
- Create: `plugin/e2e/specs/starter-agents.spec.ts`

- [ ] **Step 1: Locate starter agent manifest + daemon route**

```bash
grep -rn 'starter\|read_scopes\|write_scopes\|mcp_allowlist' plugin/daemon/src/ starter-vault/ 2>/dev/null | head -30
```
Cite manifest path + `GET /agents` shape in header comment.

- [ ] **Step 2: Write spec**

```ts
test("starter agents register with scoped read/write + mcp allowlist", async ({ request }) => {
  const state = readE2EState();
  const agents = await (await request.get(`http://127.0.0.1:${state.port}/agents`)).json();

  expect(agents.length).toBeGreaterThanOrEqual(2);

  for (const a of agents) {
    expect(a.read_scopes).toBeTruthy();
    expect(Array.isArray(a.read_scopes)).toBe(true);
    expect(a.read_scopes.length).toBeGreaterThan(0);

    expect(a.write_scopes).toBeTruthy();
    expect(Array.isArray(a.write_scopes)).toBe(true);

    expect(a.mcp_allowlist).toBeTruthy();

    // invariant: write_scopes ⊆ read_scopes
    for (const w of a.write_scopes) {
      const covered = a.read_scopes.some((r: string) => w.startsWith(r) || w === r);
      expect(covered, `write scope ${w} must be covered by read scopes for ${a.name}`).toBe(true);
    }
  }
});
```

Adjust field names per Step 1 findings if they differ.

- [ ] **Step 3: Run + commit**

```bash
cd plugin && bun e2e -- specs/starter-agents.spec.ts
git add plugin/e2e/specs/starter-agents.spec.ts
git commit -m "test(VOS-107): new starter-agents.spec — scoped read/write + allowlist invariants"
```

### Task 13: NEW — permission-deny.spec.ts (surface S7, daemon HTTP)

**Files:**
- Create: `plugin/e2e/specs/permission-deny.spec.ts`

- [ ] **Step 1: PREREQUISITE — locate tool-call route + denial shape**

```bash
grep -rn 'tool.*call\|permission\|write.*deny\|forbidden' \
  plugin/daemon/src/routes/ \
  plugin/daemon/src/server.ts \
  plugin/daemon/src/permissions/ 2>/dev/null | head -40
```

Cite resolved route path + request body schema + denial response shape (status code + body) as a comment block at the top of the spec. **The spec must NOT proceed with fabricated schemas.** If the route does not exist or denial path is not implemented, stop and file a follow-up; do not write a spec that asserts a fabricated contract.

- [ ] **Step 2: Write spec**

```ts
// resolved route: <path from step 1>
// body schema:   <fields from step 1>
// denial shape:  <status + body from step 1>
test("daemon rejects cross-scope write at HTTP boundary", async ({ request }) => {
  const state = readE2EState();
  const agentName = "<scoped agent from starter-vault>"; // resolved per starter-agents spec

  // out-of-scope write → deny
  const denyResp = await request.post(`http://127.0.0.1:${state.port}/<resolved-route>`, {
    data: { agent: agentName, path: "vault/secrets/foo.md", content: "x" },
  });
  expect(denyResp.status()).toBe(/* from step 1, e.g. */ 403);
  expect(await denyResp.json()).toMatchObject({ denied: true });

  // in-scope write → allow
  const allowResp = await request.post(`http://127.0.0.1:${state.port}/<resolved-route>`, {
    data: { agent: agentName, path: "vault/journal/foo.md", content: "x" },
  });
  expect(allowResp.status()).toBe(200);
});
```

- [ ] **Step 3: Run + commit**

```bash
cd plugin && bun e2e -- specs/permission-deny.spec.ts
git add plugin/e2e/specs/permission-deny.spec.ts
git commit -m "test(VOS-107): new permission-deny.spec — daemon HTTP boundary deny"
```

### Task 14: NEW — permission-deny-ui.spec.ts (surface S7, UI)

**Files:**
- Create: `plugin/e2e/specs/permission-deny-ui.spec.ts`
- Possibly: `plugin/e2e/fixtures/<scope>/permission-deny.jsonl` if a fake script needs to attempt the forbidden write

- [ ] **Step 1: Determine fake-cc surface for tool calls**

How does fake-cc emit a tool_use that targets a write? Read existing fixtures:
```bash
cat plugin/e2e/fixtures/ask-agent/maya.jsonl | head -20
```
Identify the tool_use shape for a write/edit tool.

- [ ] **Step 2: Author fake script that attempts forbidden write**

```jsonl
{"type":"system","subtype":"init","session_id":"e2e-perm-deny-ui"}
{"type":"assistant","message":{"content":[{"type":"text","text":"writing…"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"<write-tool-name>","input":{"path":"vault/secrets/foo.md","content":"x"}}]}}
```

- [ ] **Step 3: Write spec**

```ts
test("UI surfaces denial when agent attempts cross-scope write", async () => {
  const state = readE2EState();
  const { page } = await getVaultPage(state.cdpPort);

  // create chat with scoped agent
  // (drive via REST or picker depending on what is being asserted)

  await openChatAndSendMessage(page, "write to secrets");

  // assert denial surfaces in turn
  const denialTurn = page.getByTestId("turn-denial").first();
  await expect(denialTurn).toBeVisible({ timeout: 10_000 });
  await expect(denialTurn).toContainText(/denied|forbidden|not allowed/i);

  // chat is still responsive
  await expect(page.getByTestId("chat-composer")).toBeEnabled();
});
```

If UI does not yet have a `turn-denial` test id, fall back to asserting the daemon event reaches the plugin via `/events`:
```ts
const events = await collectEvents(state.port);
expect(events).toContainEqual(expect.objectContaining({ type: "tool_denied" }));
```

- [ ] **Step 4: Run + commit**

```bash
cd plugin && bun e2e -- specs/permission-deny-ui.spec.ts
git add plugin/e2e/specs/permission-deny-ui.spec.ts plugin/e2e/fixtures/
git commit -m "test(VOS-107): new permission-deny-ui.spec — UI denial surface"
```

---

## Phase 3 — Full green run

### Task 15: Run full suite

- [ ] **Step 1: Run all specs (existing + audited + new + fixed)**

```bash
cd /Users/admin/hub-wt/VOS-107/workspace/void-os/plugin
bun e2e -- --retries=2 2>&1 | tee /tmp/VOS-107-phase3.log
```

- [ ] **Step 2: Classify result; build summary table**

| Spec | Result (attempt 1) | Notes |
|---|---|---|
| (one row per spec) | | |

- [ ] **Step 3: On RED — loop back to Phase 2 with surgical fix**

Cap: max 2 loop iterations. On 3rd consecutive red for the same spec:
- file `VOS-*` follow-up via `/task-new VOS "..."`
- mark spec `test.skip` with comment linking the follow-up ID
- proceed to Phase 4

- [ ] **Step 4: On GREEN — record Phase 3 SHA in Work Log**

```bash
cd /Users/admin/hub && tools/state-write/sw "task(VOS-107): phase 3 green" -- bash -c '
set -e
cd /Users/admin/hub
f=$(ls vault/work/tasks/active/VOS-107-*.md | head -1)
sha=$(cd /Users/admin/hub-wt/VOS-107/workspace/void-os && git rev-parse HEAD)
cat >> "$f" <<EOF

### $(date -u +%Y-%m-%d) · phase 3 green
- green SHA: $sha
- per-spec result: <table>
EOF
git add "$f"
'
```

---

## Phase 4 — Manual UI/UX pass

### Task 16: Generate manual checklist

**Files:**
- Create: `vault/work/tasks/active/VOS-107-manual-uiux-notes.md` (state-plane, committed via `sw`)

- [ ] **Step 1: Build skeleton via `sw`**

```bash
cd /Users/admin/hub && tools/state-write/sw "task(VOS-107): manual UX checklist skeleton" -- bash -c '
set -e
cd /Users/admin/hub
cat > vault/work/tasks/active/VOS-107-manual-uiux-notes.md <<"EOF"
# VOS-107 — Manual UI/UX feedback pass

Operator-driven. Generated 2026-05-17. Companion to `vault/work/tasks/active/VOS-107-full-e2e-and-manual-uiux-pass.md`.

## Surface: S1 Agent picker (VOS-92)

### Must-touch checklist
- [ ] open picker on new chat
- [ ] pick first starter agent
- [ ] pick a different starter agent on second new chat
- [ ] close picker via Esc
- [ ] close picker via outside-click

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S2 ask_user (VOS-90)

### Must-touch checklist
- [ ] receive ask_user turn with options
- [ ] click option button → state clears
- [ ] receive ask_user turn with no options (free text)
- [ ] submit free-text answer

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S3 ask_agent subthread (VOS-89, VOS-91)

### Must-touch checklist
- [ ] receive ask_agent child turn
- [ ] expand subthread
- [ ] collapse subthread
- [ ] reload plugin, confirm subthread structure persists
- [ ] nested depth-2 displays correctly

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S4 Chat list polish (VOS-104)

### Must-touch checklist
- [ ] INPUT_REQUIRED pill renders on row with pending ask_user
- [ ] INPUT_REQUIRED pill clears after answer
- [ ] cost column renders numeric value
- [ ] cost column updates after new assistant turn

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S5 Cost meter (VOS-87)

### Must-touch checklist
- [ ] per-task cost increments after message
- [ ] per-day total in header updates
- [ ] per-day total accurate across multiple chats today

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S6 Starter agents (VOS-103, VOS-106)

### Must-touch checklist
- [ ] all expected starter agents listed in picker
- [ ] each agent has expected scope description (if surfaced in UI)
- [ ] switching between starter agents in different chats works

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Surface: S7 Permission deny (VOS-85)

### Must-touch checklist
- [ ] cross-scope write attempt produces visible feedback
- [ ] chat remains responsive after denial
- [ ] in-scope write still succeeds

### Friction notes
-

### Blocker-grade items (file follow-up)
-

## Summary

- specs added/fixed: <SHAs>
- friction items filed: <task IDs>
- regressions detected: yes/no + detail

EOF
git add vault/work/tasks/active/VOS-107-manual-uiux-notes.md
'
```

### Task 17: Operator drives manual pass (HUMAN GATE)

**Files:**
- Modify: `vault/work/tasks/active/VOS-107-manual-uiux-notes.md`

- [ ] **Step 1: Boot plugin against fresh fixture vault**

```bash
cd /Users/admin/hub-wt/VOS-107/workspace/void-os && bun run dev
```

Operator opens Obsidian against the fixture vault and drives each surface listed in the checklist.

- [ ] **Step 2: Tick checkboxes inline as actions complete**

Operator edits `vault/work/tasks/active/VOS-107-manual-uiux-notes.md` directly. Append friction notes per surface.

- [ ] **Step 3: For each blocker-grade item, file follow-up**

```bash
cd /Users/admin/hub && /Users/admin/hub/.claude/skills/task-new/... VOS "short title"
# Capture returned ID, paste into the "Blocker-grade items" line in the notes file.
```

- [ ] **Step 4: Commit the filled notes via `sw`**

```bash
cd /Users/admin/hub && tools/state-write/sw "task(VOS-107): manual UX pass notes" -- bash -c '
cd /Users/admin/hub
git add vault/work/tasks/active/VOS-107-manual-uiux-notes.md
'
```

### Task 18: Final summary + acceptance close

**Files:**
- Modify: `vault/work/tasks/active/VOS-107-full-e2e-and-manual-uiux-pass.md`
- Modify: `vault/work/tasks/active/VOS-107-manual-uiux-notes.md` (Summary block)

- [ ] **Step 1: Fill Summary in notes file**

Replace `## Summary` placeholders with concrete commits + filed task IDs + regression verdict.

- [ ] **Step 2: Tick `## Acceptance` boxes in main task file**

| Bullet | Evidence |
|---|---|
| Playwright suite covers all surfaces; green run committed | Phase 3 SHA from Task 15 step 4 |
| Manual UI/UX walkthrough notes appended to Work Log | reference to notes file + Summary block |
| Blocker-grade friction filed as separate backlog tasks | list of VOS-* IDs |
| No regression in vos-v1-router "Done when" criteria | baseline SHA + green SHA + no failed surface |

- [ ] **Step 3: Code review gate**

Dispatch one subagent for `superpowers:requesting-code-review` across the full `task/VOS-107` branch diff. Log review outcome to Work Log. Address any blocker comments before /done.

- [ ] **Step 4: Prompt user to run /done VOS-107**

---

## Self-Review (executed by author after writing this plan)

**1. Spec coverage:** every surface in the spec table (S0–S7) is covered by ≥1 task: S0 Task 3, S1 Task 10, S2 Task 9, S3 Tasks 5/6/7/8, S4 Task 4, S5 Task 11, S6 Task 12, S7 Tasks 13/14. ✓

**2. Placeholder scan:** every step has concrete content. Code blocks present. The `<resolved-route>` placeholder in Task 13 is intentional — the prerequisite step resolves it and the spec must not be written before resolution. ✓

**3. Type consistency:** `agent_name` field used consistently across tasks 9/10/11. `read_scopes`, `write_scopes`, `mcp_allowlist` consistent across spec + Task 12. Phase 3 retry cap consistent with spec doc. ✓
