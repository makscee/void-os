// VOS-153 T10: agent-rail surface.
//
// Replaces the VOS-107 SuggestModal-based picker assertions with the new
// VOS-153 contract:
//
//   1. The AgentList left-rail row for `maya` renders the rich-frontmatter
//      identity (emoji avatar, tagline preview, colour accent injected as
//      the `--agent-color` CSS variable from agent.md).
//
//   2. Clicking the rail row transitions ChatRoot into Draft mode
//      (`draft-label` visible) and does NOT mint a chat row — there is no
//      `chat-header` (Active pane) yet. That contract — picking an agent
//      is a pure UI transition, the chat is materialised on the first
//      send — is what T5 introduced and what `no-empty-chats.spec.ts`
//      locks at the daemon-truth boundary; here we lock the UI surface.
//
// Selectors confirmed against shipped T6 / T7 markup (NOT the placeholder
// snippet in the VOS-153 plan):
//
//   * Agent rail row: data-testid="agent-row" + data-agent-name="maya"
//     (AgentList.tsx:103-104). The plan's `agent-row-maya` form was a
//     placeholder — the row uses an attribute selector instead so the
//     same testid serves every row.
//   * Avatar:        .void-os-agent-avatar (AgentList.tsx:109).
//   * Tagline:       .void-os-agent-tagline (AgentList.tsx:122).
//   * Colour:        inline `--agent-color` CSS variable (AgentList.tsx:94).
//   * Draft label:   data-testid="draft-label" (DraftLabel.tsx:14).
//   * Chat header:   data-testid="chat-header" (ChatHeader.tsx:21) — absent
//                    in Draft mode by construction.
//
// The rich-frontmatter source is plugin/e2e/fixtures/agents-rich/maya/agent.md
// (copied into the daemon vault by globalSetup). Fields asserted here:
//   color:   "#5a8fd4"
//   avatar:  "🔬"
//   tagline: "Curious. Skeptical. Reads the footnotes."

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getVaultPage } from "../helpers/vault-page.ts";

interface E2EState {
  port: number;
  cdpPort: number;
  vaultPath: string;
  obsidianUserDataDir: string;
  fakeScriptPath: string;
}

function loadState(): E2EState {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  return JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
}

test("agent rail row shows avatar, tagline, and colour accent", async () => {
  test.setTimeout(60_000);
  const state = loadState();
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    // Precondition: plugin connected to daemon.
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    // Open chat view via the command palette.
    await page.evaluate(() => {
      // @ts-ignore — `app` is Obsidian's global in the renderer.
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });

    // Dismiss any first-launch modals (Settings / Community-plugins) —
    // mirrors the pattern in no-empty-chats + chat-roundtrip specs.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const row = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Avatar emoji from agents-rich/maya/agent.md frontmatter.
    await expect(row.locator(".void-os-agent-avatar")).toContainText("🔬");

    // Tagline preview (T6 prefers `tagline` over `description`).
    await expect(row.locator(".void-os-agent-tagline")).toContainText("Curious");

    // Colour accent — AgentList writes the agent's `color` into the
    // inline `--agent-color` CSS var. The browser normalises hex colours
    // to lowercase but preserves the form, so we trim and lowercase
    // before comparing.
    const color = await row.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--agent-color").trim().toLowerCase(),
    );
    expect(color).toBe("#5a8fd4");
  } finally {
    await browser.close();
  }
});

test("clicking an agent rail row transitions to Draft mode (no chat row created)", async () => {
  test.setTimeout(60_000);
  const state = loadState();
  const { browser, page } = await getVaultPage(state.cdpPort);

  try {
    await expect(page.getByTestId("vos-status-bar"))
      .toHaveText("void-os: connected", { timeout: 20_000 });

    await page.evaluate(() => {
      // @ts-ignore
      window.app.commands.executeCommandById("void-os:open-chat-view");
    });
    await expect(page.getByTestId("vos-chat-root")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const row = page.locator("[data-testid='agent-row'][data-agent-name='maya']");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ force: true, timeout: 5_000 });

    // Draft label is the Draft-pane signature (DraftLabel.tsx, T5).
    await expect(page.getByTestId("draft-label")).toBeVisible({ timeout: 5_000 });

    // ChatHeader is the Active-pane banner (T7); it must NOT have mounted
    // yet — that is the whole point of the no-empty-chats contract.
    await expect(page.getByTestId("chat-header")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
