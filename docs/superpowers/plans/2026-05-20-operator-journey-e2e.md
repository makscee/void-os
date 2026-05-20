# Operator-Journey E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single long-running staged Playwright journey that imitates the operator installing and using void-os end-to-end (fresh-install → chat → create agent → start task → debug trace), screenshotting and layout-checking each stage, resumable per-stage.

**Architecture:** One new spec `plugin/e2e/specs/operator-journey.spec.ts` as a `test.describe.serial` with 6 stage `test(...)`s, run as its own Playwright `journey` project (own daemon + Obsidian). A `journey-report.ts` helper module accumulates per-stage results and writes a JSON report in `afterAll`. Layout drift = `toHaveScreenshot` regression + a `boundingClientRect` first-run guard. Each daemon-dependent stage self-seeds so it is independently `--grep`-runnable.

**Tech Stack:** Playwright (`@playwright/test` ^1.50), Bun, the existing `plugin/e2e/` harness (`globalSetup.ts` `setupE2E`, `getVaultPage` helper).

---

### Task 1: Journey project wiring (config + globalSetup/teardown)

**Files:**
- Modify: `plugin/e2e/playwright.config.ts` — add `journey` project
- Create: `plugin/e2e/globalSetup-journey.ts`
- Create: `plugin/e2e/globalTeardown-journey.ts`
- Modify: `plugin/e2e/globalSetup-all.ts` — chain journey setup
- Modify: `plugin/e2e/globalTeardown-all.ts` — chain journey teardown
- Modify: `plugin/package.json` — add `e2e:journey` script

- [ ] **Step 1: Inspect the existing chained-project pattern**

Read `plugin/e2e/globalSetup-ask-user.ts` and `globalSetup-all.ts` to copy the exact `setupE2E({ stateEnvVar, tmpDirSuffix })` shape. The journey gets `stateEnvVar: "VOS_E2E_STATE_JOURNEY"`, `tmpDirSuffix: "journey"`.

- [ ] **Step 2: Create `globalSetup-journey.ts`**

```ts
// plugin/e2e/globalSetup-journey.ts
// VOS-163: dedicated daemon + Obsidian for the operator-journey spec.
import { setupE2E } from "./globalSetup.ts";

export default async function globalSetupJourney() {
  await setupE2E({
    stateEnvVar: "VOS_E2E_STATE_JOURNEY",
    tmpDirSuffix: "journey",
  });
}
```

- [ ] **Step 3: Create `globalTeardown-journey.ts`**

Mirror `globalTeardown-ask-user.ts`: read the `VOS_E2E_STATE_JOURNEY` sidecar, kill `daemonPid` + `obsidianPid`, rm the tmpdir. Copy that file's body verbatim, swapping the env var name.

- [ ] **Step 4: Chain journey into `globalSetup-all.ts` / `globalTeardown-all.ts`**

Append `await (await import("./globalSetup-journey.ts")).default();` after the existing chained projects in `globalSetup-all.ts`, and the teardown equivalent in `globalTeardown-all.ts`. Match the existing import-and-call style in those files exactly.

- [ ] **Step 5: Add the `journey` project to `playwright.config.ts`**

In the `projects` array add:
```ts
{
  name: "journey",
  testMatch: ["**/operator-journey.spec.ts"],
},
```
Leave existing projects' `testIgnore` alone — `operator-journey.spec.ts` is not matched by `main` (main has no testIgnore for it, but `testMatch` on `journey` keeps it project-scoped; add `**/operator-journey.spec.ts` to `main`'s `testIgnore` so `bun run e2e` does not pick it up).

- [ ] **Step 6: Add `e2e:journey` script to `plugin/package.json`**

```json
"e2e:journey": "bunx playwright test --config e2e/playwright.config.ts --project=journey"
```

- [ ] **Step 7: Verify wiring compiles**

Run: `cd plugin && bunx tsc -p tsconfig.json --noEmit` (if a tsconfig covers e2e) OR `bunx playwright test --config e2e/playwright.config.ts --list --project=journey`
Expected: lists 0 tests (spec not written yet) with no config error.

- [ ] **Step 8: Commit**

```bash
git add plugin/e2e/playwright.config.ts plugin/e2e/globalSetup-journey.ts plugin/e2e/globalTeardown-journey.ts plugin/e2e/globalSetup-all.ts plugin/e2e/globalTeardown-all.ts plugin/package.json
git commit -m "test(VOS-163): wire journey Playwright project"
```

---

### Task 2: Journey report helper

**Files:**
- Create: `plugin/e2e/helpers/journey-report.ts`

- [ ] **Step 1: Write the helper**

```ts
// plugin/e2e/helpers/journey-report.ts
// VOS-163: per-stage report accumulator for the operator-journey spec.
// Each stage appends a StageResult; afterAll serialises the array to
// test-results/operator-journey-report.json and prints a table.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LayoutVerdict = "ok" | "drift" | "first-run";

export interface StageResult {
  stage: string;
  screenshotPath: string;
  layoutVerdict: LayoutVerdict;
  pass: boolean;
  note?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// plugin/e2e/helpers -> plugin/test-results
const REPORT_PATH = resolve(HERE, "..", "..", "test-results", "operator-journey-report.json");

const results: StageResult[] = [];

export function recordStage(r: StageResult): void {
  results.push(r);
}

export function writeJourneyReport(): string {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), stages: results }, null, 2));
  // Human-readable table to stdout.
  const rows = results.map(
    (r) => `  ${r.pass ? "PASS" : "FAIL"}  ${r.stage.padEnd(20)} layout=${r.layoutVerdict.padEnd(10)} ${r.screenshotPath}`,
  );
  // eslint-disable-next-line no-console
  console.log(["", "── operator-journey report ──", ...rows, ""].join("\n"));
  return REPORT_PATH;
}

/** Screenshot dir for explicit per-stage artifacts. */
export function stageShotPath(stage: string): string {
  const dir = resolve(HERE, "..", "..", "test-results", "journey-shots");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${stage}.png`);
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd plugin && bunx tsc --noEmit e2e/helpers/journey-report.ts` (best-effort; if no per-file tsc, defer to Task 3's spec run)
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add plugin/e2e/helpers/journey-report.ts
git commit -m "test(VOS-163): add journey-report helper"
```

---

### Task 3: Layout-check helper

**Files:**
- Create: `plugin/e2e/helpers/layout-check.ts`

- [ ] **Step 1: Write the helper**

```ts
// plugin/e2e/helpers/layout-check.ts
// VOS-163: layout-drift guards for the operator-journey spec.
//   assertBox  — first-run / no-baseline guard: the surface exists, is
//                on-screen, and has non-zero size.
//   layoutShot — toHaveScreenshot regression gate, tolerant of font AA.
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Coarse layout guard usable before any screenshot baseline exists.
 * Asserts the located surface has a non-zero box that sits inside the
 * viewport. Returns the box for callers that want to log it.
 */
export async function assertBox(page: Page, locator: Locator, label: string) {
  await expect(locator, `${label}: surface must be visible`).toBeVisible({ timeout: 15_000 });
  const box = await locator.boundingBox();
  expect(box, `${label}: boundingBox null`).not.toBeNull();
  const b = box!;
  expect(b.width, `${label}: zero width`).toBeGreaterThan(0);
  expect(b.height, `${label}: zero height`).toBeGreaterThan(0);
  const vp = page.viewportSize() ?? { width: 99999, height: 99999 };
  expect(b.x, `${label}: off-screen left`).toBeGreaterThanOrEqual(-2);
  expect(b.y, `${label}: off-screen top`).toBeGreaterThanOrEqual(-2);
  expect(b.x, `${label}: off-screen right`).toBeLessThan(vp.width);
  expect(b.y, `${label}: off-screen bottom`).toBeLessThan(vp.height);
  return b;
}

/**
 * Screenshot-diff regression gate. On the first run Playwright writes the
 * baseline (and the test is marked first-run by the caller); thereafter it
 * pixel-diffs with a tolerance that absorbs Obsidian font/AA noise.
 */
export async function layoutShot(locator: Locator, name: string) {
  await expect(locator).toHaveScreenshot(`${name}.png`, {
    maxDiffPixelRatio: 0.02,
    animations: "disabled",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add plugin/e2e/helpers/layout-check.ts
git commit -m "test(VOS-163): add layout-check helper"
```

---

### Task 4: Journey spec skeleton — S1 fresh-install + S2 open-chat

**Files:**
- Create: `plugin/e2e/specs/operator-journey.spec.ts`

- [ ] **Step 1: Write the spec skeleton with stages S1 and S2**

```ts
// plugin/e2e/specs/operator-journey.spec.ts
//
// VOS-163 — Operator-journey E2E. ONE continuous, staged walkthrough that
// imitates the operator installing and using void-os: fresh-install ->
// open chat -> chat with an agent -> create an agent -> start a task ->
// debug an agent trace in the InspectorView.
//
// Run whole journey:   bun run e2e:journey
// Run one stage:       bun run e2e:journey -- --grep "S4"
// Run a range:         bun run e2e:journey -- --grep "S3|S4|S5"
//
// `test.describe.serial` runs the stages in order and SKIPS downstream
// stages if an upstream one fails — checkpoint-on-failure. Every stage
// screenshots its surface and runs the layout-drift check. Stages that
// need daemon state self-seed (mint their own chat/run) so any stage is
// independently --grep-runnable from a cold harness; see e2e/JOURNEY.md.
//
// Harness traps heeded (workspace/void-os/CLAUDE.md): ribbon clicks go via
// page.evaluate(el => el.click()); inline CDP via getVaultPage; force
// clicks for Obsidian bare-div surfaces; generous cold-boot timeouts.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";
import { assertBox, layoutShot } from "../helpers/layout-check.ts";
import {
  recordStage,
  writeJourneyReport,
  stageShotPath,
  type LayoutVerdict,
} from "../helpers/journey-report.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  tmpdir: string;
}

function loadState(): E2EState {
  const p = process.env.VOS_E2E_STATE_JOURNEY;
  if (!p) throw new Error("VOS_E2E_STATE_JOURNEY not set — globalSetup-journey did not run");
  return JSON.parse(readFileSync(p, "utf8")) as E2EState;
}

/**
 * Run a stage body: connect, give the body the page, screenshot + layout
 * check, record the result. Keeps each stage test small + uniform.
 */
async function runStage(
  stage: string,
  body: (page: Page, state: E2EState) => Promise<{ surface: ReturnType<Page["getByTestId"]>; layoutName: string }>,
): Promise<void> {
  const state = loadState();
  const { browser, page } = await getVaultPage(state.cdpPort);
  let verdict: LayoutVerdict = "ok";
  let pass = false;
  const shot = stageShotPath(stage);
  try {
    const { surface, layoutName } = await body(page, state);
    await assertBox(page, surface, stage);
    await page.screenshot({ path: shot });
    try {
      await layoutShot(surface, layoutName);
    } catch (e) {
      // A missing baseline throws on first run; toHaveScreenshot writes it
      // then. Treat a baseline-write as "first-run", a real diff as "drift".
      verdict = /A snapshot doesn't exist/.test(String(e)) ? "first-run" : "drift";
      if (verdict === "drift") throw e;
    }
    pass = true;
  } finally {
    recordStage({ stage, screenshotPath: shot, layoutVerdict: verdict, pass });
    await browser.close();
  }
}

test.describe.serial("operator journey", () => {
  test.afterAll(() => {
    writeJourneyReport();
  });

  test("[S1 fresh-install] clean boot: plugin loads + connects", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S1-fresh-install", async (page, state) => {
      // Fresh harness = a clean install: fresh tmpdir, user-data-dir, DB,
      // freshly-built plugin. Assert the clean-boot state.
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Daemon reachable + no stray chats from a prior life.
      const agents = await request.get(`http://127.0.0.1:${state.port}/agents`);
      expect(agents.status()).toBe(200);
      const chats = await request.get(`http://127.0.0.1:${state.port}/chats`);
      expect(chats.status()).toBe(200);
      // Surface for the layout check: the Obsidian workspace root.
      return { surface: page.getByTestId("vos-status-bar"), layoutName: "s1-statusbar" };
    });
  });

  test("[S2 open-chat] open chat view, agent rail renders", async () => {
    test.setTimeout(120_000);
    await runStage("S2-open-chat", async (page) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Operator opens chat via the ribbon icon — Obsidian renders ribbon
      // items as bare divs; dispatch the native click in-page.
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          '.side-dock-ribbon-action[aria-label="void-os chat"]',
        );
        if (!el) throw new Error("void-os ribbon icon missing");
        el.click();
      });
      const chatRoot = page.getByTestId("vos-chat-root");
      await expect(chatRoot).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      const rail = page.getByTestId("agent-list");
      await expect(rail).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => page.getByTestId("agent-row").count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s2-chat-root" };
    });
  });
});
```

- [ ] **Step 2: Run S1 + S2**

Run: `cd plugin && bun run e2e:journey -- --grep "S1|S2"`
Expected: both stages PASS; `test-results/operator-journey-report.json` written; `test-results/journey-shots/S1-fresh-install.png` + `S2-open-chat.png` exist. First run prints `layout=first-run`.

- [ ] **Step 3: Commit (including the generated screenshot baselines)**

```bash
git add plugin/e2e/specs/operator-journey.spec.ts plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey stages S1 fresh-install + S2 open-chat"
```

---

### Task 5: Stage S3 — chat with the tinker agent

**Files:**
- Modify: `plugin/e2e/specs/operator-journey.spec.ts` — add S3 test

**Note on "tinker":** discovery found the e2e fixture seeds agents `maya`, `journaler`, `deep`. There is no `tinker` agent in the fixture vault. The operator's "tinker" is their dogfood-vault default agent; in the e2e harness the stand-in is `maya` (the agent the fake script is pinned to). S3 chats with `maya`. Confirm at impl time by `grep -ri tinker plugin/ daemon/` — if a `tinker` agent exists in a starter vault, prefer seeding it; otherwise document maya as the stand-in in `JOURNEY.md`.

- [ ] **Step 1: Add the S3 test before the closing `});` of the describe block**

```ts
  test("[S3 chat-tinker] draft + send a message, chat goes Active", async () => {
    test.setTimeout(120_000);
    await runStage("S3-chat-tinker", async (page) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Self-seed: open chat fresh (cold-resumable).
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          '.side-dock-ribbon-action[aria-label="void-os chat"]',
        );
        el?.click();
      });
      const chatRoot = page.getByTestId("vos-chat-root");
      await expect(chatRoot).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      // Click an agent row -> Draft pane (the fake script is pinned to
      // maya; maya is the tinker stand-in — see JOURNEY.md).
      const mayaRow = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
      await expect(mayaRow).toBeVisible({ timeout: 10_000 });
      await mayaRow.click({ force: true, timeout: 5_000 });
      const composer = page.getByTestId("draft-composer");
      await expect(composer).toBeVisible({ timeout: 10_000 });
      // Type + send like the operator would.
      await composer.click();
      await page.keyboard.type("hello from the operator journey");
      await page.getByTestId("draft-send").click({ force: true, timeout: 5_000 });
      // The chat materialises Active and the assistant turn renders.
      await expect(page.getByTestId("chat-active")).toBeVisible({ timeout: 20_000 });
      return { surface: chatRoot, layoutName: "s3-chat-active" };
    });
  });
```

- [ ] **Step 2: Run S3 standalone (cold-resumable check)**

Run: `cd plugin && bun run e2e:journey -- --grep "S3"`
Expected: PASS. If `draft-send` / `draft-composer` selectors differ, grep `plugin/src/chat/ChatRoot.tsx` for the real testids and correct them.

- [ ] **Step 3: Commit**

```bash
git add plugin/e2e/specs/operator-journey.spec.ts plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey stage S3 chat-tinker"
```

---

### Task 6: Stage S4 — create an agent

**Files:**
- Modify: `plugin/e2e/specs/operator-journey.spec.ts` — add S4 test
- Possibly modify: `plugin/e2e/helpers/journey-report.ts` — none expected

- [ ] **Step 1: Confirm the agent-creation surface**

Run: `grep -rin "create.*agent\|new.*agent\|addAgent" plugin/src daemon/src | grep -vi test`
Decision:
- If a plugin UI command/modal for creating an agent exists → S4 drives it.
- If NOT (expected — agents are vault frontmatter files) → S4 "creates an agent" by writing `agents/journey-bot/agent.md` into the harness vault (`state.vaultPath`), then asserting the daemon scanner picks it up via `GET /agents` and the chat rail re-renders to include it. This IS the operator's manual path (they author agent files).

- [ ] **Step 2: Add the S4 test (file-authoring variant — adjust if a UI exists)**

```ts
  test("[S4 create-agent] author an agent file, daemon + rail pick it up", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S4-create-agent", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Operator "creates an agent": author agents/journey-bot/agent.md.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(state.vaultPath, "agents", "journey-bot");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agent.md"),
        "---\nname: journey-bot\ndescription: agent minted by the operator journey\nmodel: haiku\n---\n",
      );
      // The daemon rescans agents on a vault-file change; poll /agents.
      await expect
        .poll(async () => {
          const r = await request.get(`http://127.0.0.1:${state.port}/agents`);
          if (r.status() !== 200) return [];
          const body = (await r.json()) as { agents?: Array<{ name: string }> } | Array<{ name: string }>;
          const list = Array.isArray(body) ? body : body.agents ?? [];
          return list.map((a) => a.name);
        }, { timeout: 15_000 })
        .toContain("journey-bot");
      // Open chat; the rail should reflect the new agent.
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          '.side-dock-ribbon-action[aria-label="void-os chat"]',
        );
        el?.click();
      });
      const chatRoot = page.getByTestId("vos-chat-root");
      await expect(chatRoot).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      // Rail re-render may need a reopen; poll the row directly.
      await expect
        .poll(async () =>
          page.locator("[data-testid='agent-row'][data-agent-name='journey-bot']").count(),
          { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s4-rail-with-new-agent" };
    });
  });
```

- [ ] **Step 2b: If S4's rail does not auto-refresh**

If `journey-bot` reaches `GET /agents` but never appears in the rail without a manual reload, that is a SURFACED ISSUE — record it: do NOT add reload hacks. Keep the `GET /agents` assertion (proves daemon side) and downgrade the rail assertion to `recordStage(... pass:false, note:"rail did not auto-refresh on new agent")` by wrapping it in a try/catch that records the note and rethrows only after the report row is set. Document it in the Work Log.

- [ ] **Step 3: Run S4 standalone**

Run: `cd plugin && bun run e2e:journey -- --grep "S4"`
Expected: PASS, or a clean recorded FAIL with the rail-refresh note.

- [ ] **Step 4: Commit**

```bash
git add plugin/e2e/specs/operator-journey.spec.ts plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey stage S4 create-agent"
```

---

### Task 7: Stage S5 — start working on a task

**Files:**
- Modify: `plugin/e2e/specs/operator-journey.spec.ts` — add S5 test

**Note:** "start working on a task" = dispatch a chat run that produces a multi-event run. The fake provider's maya script emits token/status/end frames. S5 mints + sends a chat over REST (faster, less flaky than UI per harness trap), then asserts the run produced events the inspector can later show.

- [ ] **Step 1: Add the S5 test**

```ts
  test("[S5 start-task] dispatch a run, daemon produces a trace", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S5-start-task", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Self-seed a run over REST (harness trap: drive chats via REST when
      // the picker is not under test).
      const mint = await request.post(`http://127.0.0.1:${state.port}/chats`, {
        data: { agent: "maya" },
      });
      expect(mint.status()).toBe(200);
      const chatId = ((await mint.json()) as { id: string }).id;
      const send = await request.post(
        `http://127.0.0.1:${state.port}/chat/${chatId}/message`,
        { data: { text: "start the task" } },
      );
      expect([200, 201, 202]).toContain(send.status());
      // Surface to screenshot: the chat view showing the live conversation.
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          '.side-dock-ribbon-action[aria-label="void-os chat"]',
        );
        el?.click();
      });
      const chatRoot = page.getByTestId("vos-chat-root");
      await expect(chatRoot).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      // The run is in flight — inspector stage (S6) consumes it. Here we
      // just confirm a chat row exists in the list.
      await expect.poll(async () => page.getByTestId("chat-row-title").count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s5-chat-list" };
    });
  });
```

- [ ] **Step 2: Run S5 standalone**

Run: `cd plugin && bun run e2e:journey -- --grep "S5"`
Expected: PASS. Correct `chat-row-title` if `grep plugin/src/chat/ChatList.tsx` shows a different testid.

- [ ] **Step 3: Commit**

```bash
git add plugin/e2e/specs/operator-journey.spec.ts plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey stage S5 start-task"
```

---

### Task 8: Stage S6 — debug agent trace in the InspectorView

**Files:**
- Modify: `plugin/e2e/specs/operator-journey.spec.ts` — add S6 test

**Note:** S6 self-seeds its own run (inspector inflight registry only lingers ~10s — R2). It mirrors `inspector-view.spec.ts` against what is on main `e031e10`. VOS-162 branch-verb / Source-A is out of scope.

- [ ] **Step 1: Add the S6 test**

```ts
  test("[S6 debug-trace] open inspector, expand an agent's trace", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S6-debug-trace", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      // Self-seed: dispatch a run so the inflight registry has a row.
      const mint = await request.post(`http://127.0.0.1:${state.port}/chats`, {
        data: { agent: "maya" },
      });
      expect(mint.status()).toBe(200);
      const chatId = ((await mint.json()) as { id: string }).id;
      const send = await request.post(
        `http://127.0.0.1:${state.port}/chat/${chatId}/message`,
        { data: { text: "trace me" } },
      );
      expect([200, 201, 202]).toContain(send.status());
      // Open the inspector via its command.
      await page.evaluate(() => {
        // @ts-ignore — app is the Obsidian global in the renderer.
        window.app.commands.executeCommandById("void-os:open-inspector-view");
      });
      const inspector = page.getByTestId("vos-inspector-root");
      await expect(inspector).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      // The in-flight agent row appears WITHOUT a manual reload.
      const agentRow = page.getByTestId("inspector-agent-row").first();
      await expect(agentRow).toBeVisible({ timeout: 20_000 });
      // Click the row -> step-by-step trace expands.
      await agentRow.click({ force: true, timeout: 5_000 });
      const trace = page.getByTestId("inspector-trace");
      await expect(trace).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => page.getByTestId("inspector-trace-event").count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: inspector, layoutName: "s6-inspector-trace" };
    });
  });
```

- [ ] **Step 2: Run S6 standalone**

Run: `cd plugin && bun run e2e:journey -- --grep "S6"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugin/e2e/specs/operator-journey.spec.ts plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey stage S6 debug-trace"
```

---

### Task 9: JOURNEY.md operator doc + full-run shakedown

**Files:**
- Create: `plugin/e2e/JOURNEY.md`

- [ ] **Step 1: Write `JOURNEY.md`**

Document: the 6 stage ids, the `bun run e2e:journey` recipes (whole / single `--grep "S4"` / range `--grep "S3|S4|S5"`), which stages are cold-resumable (all self-seed: S1, S2 always; S3, S4, S5, S6 self-seed) vs which assume a warm predecessor (none — every stage self-seeds, document that explicitly), the report path `test-results/operator-journey-report.json`, the screenshot artifact dir, and how to regenerate baselines (`--update-snapshots`). State the maya = tinker stand-in. State that a stage FAIL is a product issue → file a VOS-* task, then re-run just that stage after the fix.

- [ ] **Step 2: Full journey run**

Run: `cd plugin && bun run e2e:journey`
Expected: report written. Record every FAIL / drift row — these are the surfaced issues.

- [ ] **Step 3: Commit**

```bash
git add plugin/e2e/JOURNEY.md plugin/e2e/specs/operator-journey.spec.ts-snapshots
git commit -m "test(VOS-163): journey operator doc + baselines"
```

---

## Self-review

- Spec coverage: Acceptance 1 (staged spec) → Tasks 4-8; AC2 (journey project) → Task 1; AC3 (grep running) → Tasks 4-8 step "run standalone" + Task 9; AC4 (screenshot + layout) → Tasks 2,3 + `runStage`; AC5 (self-seed + JOURNEY.md) → Tasks 5-9; AC6 (report) → Task 2 + `afterAll`; AC7 (first-run issues) → Task 9 + Work Log; AC8 (reuse harness) → Task 1 reuses `setupE2E`, all stages use `getVaultPage`.
- Placeholder scan: no TBD/TODO; the only conditional is S4's surface (Task 6 Step 1 resolves it deterministically at impl).
- Type consistency: `StageResult`, `LayoutVerdict`, `recordStage`, `writeJourneyReport`, `stageShotPath` defined in Task 2, used consistently in Task 4's `runStage`. `assertBox`/`layoutShot` from Task 3 used in `runStage`.
