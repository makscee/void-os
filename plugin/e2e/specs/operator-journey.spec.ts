// plugin/e2e/specs/operator-journey.spec.ts
//
// VOS-163 — Operator-journey E2E. ONE continuous, staged walkthrough that
// imitates the operator installing and using void-os end-to-end:
//   S1 fresh-install -> S2 open-chat -> S3 chat-tinker ->
//   S4 create-agent  -> S5 start-task -> S6 debug-trace
//
// Run whole journey:   bun run e2e:journey
// Run one stage:       bun run e2e:journey -- --grep "S4"
// Run a range:         bun run e2e:journey -- --grep "S3|S4|S5"
//
// `test.describe` runs the stages in declaration order on a single worker
// (workers:1). Stages are NOT serial-dependent: each one SELF-SEEDS its
// daemon state (mints its own chat/run, authors its own files), so a
// failing stage does NOT skip the stages after it — the journey keeps
// testing further while a surfaced bug is fixed on a parallel task. Every
// stage screenshots its surface and runs the layout-drift check, and is
// independently --grep-runnable from a cold harness; see e2e/JOURNEY.md.
//
// Harness traps heeded (workspace/void-os/CLAUDE.md): ribbon clicks go via
// page.evaluate(el => el.click()) — Obsidian ribbon items are bare divs;
// inline CDP via getVaultPage; force clicks for bare-div surfaces;
// REST-driven chats where the picker is not the surface under test;
// generous cold-boot timeouts. The fake provider is hard-pinned to the
// `maya` script, so `maya` is the in-harness stand-in for the operator's
// "tinker" default agent.
import { test, expect, type Locator, type Page } from "@playwright/test";
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
  if (!p) {
    throw new Error(
      "VOS_E2E_STATE_JOURNEY not set — globalSetup-journey did not run",
    );
  }
  return JSON.parse(readFileSync(p, "utf8")) as E2EState;
}

interface StageSurface {
  surface: Locator;
  layoutName: string;
  /** Optional looser screenshot tolerance for content-variable surfaces. */
  maxDiffPixelRatio?: number;
  /**
   * Skip the pixel screenshot-diff gate for this stage and rely on the
   * structural `assertBox` guard alone. Use when the surface AUTO-SIZES to
   * variable content (e.g. the inspector panel width tracks the length of
   * agent / task ids) — a pixel diff there is noise, not layout drift.
   */
  shotMode?: "pixel" | "structural-only";
}

/**
 * Run a stage body uniformly: connect over CDP, hand the body the page +
 * state, then screenshot the body's chosen surface, run the layout-drift
 * check, and record the per-stage report row. Keeps each stage test small.
 *
 * A missing screenshot baseline (first run) is NOT a failure — the verdict
 * is recorded as "first-run". A real pixel diff IS a failure ("drift").
 */
async function runStage(
  stage: string,
  body: (page: Page, state: E2EState) => Promise<StageSurface>,
): Promise<void> {
  const state = loadState();
  const { browser, page } = await getVaultPage(state.cdpPort);
  let verdict: LayoutVerdict = "ok";
  let pass = false;
  let note: string | undefined;
  const shot = stageShotPath(stage);
  try {
    const { surface, layoutName, maxDiffPixelRatio, shotMode } =
      await body(page, state);
    // Structural guard — runs for EVERY stage; the first-run / no-baseline
    // layout check. Catches collapsed / off-screen surfaces.
    await assertBox(page, surface, stage);
    await page.screenshot({ path: shot });
    if (shotMode === "structural-only") {
      // Surface auto-sizes to variable content — the structural guard
      // above IS the layout-drift check; a pixel diff would be noise.
      verdict = "ok";
    } else {
      try {
        await layoutShot(surface, layoutName, maxDiffPixelRatio);
      } catch (e) {
        const msg = String(e);
        if (/A snapshot doesn't exist|snapshot doesn't exist/.test(msg)) {
          // First run — Playwright just wrote the baseline. Not a failure.
          verdict = "first-run";
        } else {
          verdict = "drift";
          throw e;
        }
      }
    }
    pass = true;
  } catch (e) {
    note = note ?? String(e).split("\n")[0];
    throw e;
  } finally {
    recordStage({ stage, screenshotPath: shot, layoutVerdict: verdict, pass, note });
    await browser.close();
  }
}

// `vos-chat-root` / `chat-root` are display:contents wrappers — they have
// NO layout box, so they cannot be screenshotted or bounding-box checked.
// The boxed surface for the chat view is Obsidian's leaf-content container.
const CHAT_LEAF = '.workspace-leaf-content[data-type="void-os-chat"]';

/**
 * Open the chat view via the ribbon icon — the operator's real path.
 * Returns the BOXED leaf-content locator (suitable for layout checks);
 * callers still assert on the inner testids for behaviour.
 */
async function openChatViaRibbon(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '.side-dock-ribbon-action[aria-label="void-os chat"]',
    );
    if (!el) throw new Error("void-os ribbon icon missing");
    el.click();
  });
  // The display:contents chat-root mounts inside the leaf — wait on it for
  // the React-tree-ready signal, then return the boxed leaf container.
  await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  const leaf = page.locator(CHAT_LEAF).first();
  await expect(leaf).toBeVisible({ timeout: 10_000 });
  return leaf;
}

test.describe("operator journey", () => {
  test.afterAll(() => {
    writeJourneyReport();
  });

  // ── S1 — fresh install ────────────────────────────────────────────────
  // The Playwright harness IS a clean install each run: fresh tmpdir,
  // fresh user-data-dir, fresh DB, plugin freshly built into a throwaway
  // vault. S1 asserts that clean-boot state.
  test("[S1 fresh-install] clean boot: plugin loads + connects", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S1-fresh-install", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      const agents = await request.get(`http://127.0.0.1:${state.port}/agents`);
      expect(agents.status()).toBe(200);
      const chats = await request.get(`http://127.0.0.1:${state.port}/chats`);
      expect(chats.status()).toBe(200);
      return { surface: page.getByTestId("vos-status-bar"), layoutName: "s1-statusbar" };
    });
  });

  // ── S2 — open chat view ───────────────────────────────────────────────
  test("[S2 open-chat] open chat view, agent rail renders", async () => {
    test.setTimeout(120_000);
    await runStage("S2-open-chat", async (page) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      const chatRoot = await openChatViaRibbon(page);
      const rail = page.getByTestId("agent-list");
      await expect(rail).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => page.getByTestId("agent-row").count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s2-chat-root" };
    });
  });

  // ── S3 — chat with the tinker agent (maya stand-in) ───────────────────
  test("[S3 chat-tinker] draft + send a message, chat goes Active", async () => {
    test.setTimeout(120_000);
    await runStage("S3-chat-tinker", async (page) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      const chatRoot = await openChatViaRibbon(page);
      // Click the maya row -> Draft pane (maya = tinker stand-in).
      const mayaRow = page.locator(
        "[data-testid='agent-row'][data-agent-name='maya']",
      );
      await expect(mayaRow).toBeVisible({ timeout: 10_000 });
      await mayaRow.click({ force: true, timeout: 5_000 });
      const composer = page.getByTestId("draft-composer");
      await expect(composer).toBeVisible({ timeout: 10_000 });
      // Type + send like the operator would.
      await composer.click();
      await page.keyboard.type("hello from the operator journey");
      await page.getByTestId("draft-send").click({ force: true, timeout: 5_000 });
      // The chat materialises Active.
      await expect(page.getByTestId("chat-active")).toBeVisible({ timeout: 20_000 });
      return { surface: chatRoot, layoutName: "s3-chat-active" };
    });
  });

  // ── S4 — create an agent ──────────────────────────────────────────────
  // The operator's manual path: author an agents/<name>/agent.md file and
  // expect the daemon's vault scanner to pick it up + the chat rail to
  // reflect it.
  //
  // SURFACED ISSUE (first run, 2026-05-20): the daemon runs scanVaultAgents
  // ONCE at boot (daemon/src/index.ts:77) — there is NO vault watcher /
  // runtime rescan. An agent file authored after the daemon started is
  // invisible to GET /agents until the daemon restarts. This stage fails
  // until a "rescan agents on vault change" task lands; it is left here as
  // the journey's regression check for that fix.
  test("[S4 create-agent] author an agent file, daemon + rail pick it up", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S4-create-agent", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(state.vaultPath, "agents", "journey-bot");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agent.md"),
        "---\nname: journey-bot\ndescription: agent minted by the operator journey\nmodel: haiku\n---\n",
      );
      // Boxed surface for the layout check — capture the chat view even if
      // the daemon-side assertion below fails, so the report still has a
      // screenshot.
      const chatRoot = await openChatViaRibbon(page);
      // Daemon side: the new agent must reach GET /agents. KNOWN-FAILING
      // until runtime agent rescan exists — see the SURFACED ISSUE note.
      await expect
        .poll(
          async () => {
            const r = await request.get(`http://127.0.0.1:${state.port}/agents`);
            if (r.status() !== 200) return [];
            const body = (await r.json()) as
              | { agents?: Array<{ name: string }> }
              | Array<{ name: string }>;
            const list = Array.isArray(body) ? body : body.agents ?? [];
            return list.map((a) => a.name);
          },
          { timeout: 15_000 },
        )
        .toContain("journey-bot");
      // UI side: the chat rail should reflect the new agent.
      await expect
        .poll(
          async () =>
            page
              .locator("[data-testid='agent-row'][data-agent-name='journey-bot']")
              .count(),
          { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s4-rail-with-new-agent" };
    });
  });

  // ── S5 — start working on a task ──────────────────────────────────────
  // Dispatch a run via REST (faster + less flaky than the UI picker when
  // the picker is not the surface under test). The fake maya script emits
  // token/status/end frames — a multi-event "task" run.
  test("[S5 start-task] dispatch a run, chat list shows the conversation", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S5-start-task", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
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
      const chatRoot = await openChatViaRibbon(page);
      await expect
        .poll(async () => page.getByTestId("chat-row-title").count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      return { surface: chatRoot, layoutName: "s5-chat-list" };
    });
  });

  // ── S6 — debug an agent trace in the InspectorView ────────────────────
  // Self-seeds its own run (the inspector inflight registry lingers only
  // ~10s after a run ends, so S6 cannot rely on S5's timing). Mirrors
  // inspector-view.spec.ts against void-os main e031e10. VOS-162
  // branch-verb / Source-A surfaces are out of scope.
  test("[S6 debug-trace] open inspector, expand an agent's trace", async ({ request }) => {
    test.setTimeout(120_000);
    await runStage("S6-debug-trace", async (page, state) => {
      await expect(page.getByTestId("vos-status-bar"))
        .toHaveText("void-os: connected", { timeout: 30_000 });
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
      await expect
        .poll(async () => page.getByTestId("inspector-trace-event").count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      // The inspector panel AUTO-SIZES to variable-length agent / task
      // ids, so a pixel screenshot diff is run-to-run noise, not layout
      // drift. The structural assertBox guard (visible, boxed, on-screen)
      // IS the layout-drift check for this stage.
      return {
        surface: inspector,
        layoutName: "s6-inspector-trace",
        shotMode: "structural-only",
      };
    });
  });
});
