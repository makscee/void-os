// VOS-228 THE PROOF — kanban end-to-end, real Chromium against a live void-os daemon.
//
// This is the milestone done-signal. It drives the ACTUAL void-os UI in a real browser and
// asserts WIRING (not LLM timing, not screenshot-presence):
//
//   step 1  open the void-os dashboard; the launch modal (type-a-prompt surface) is real + wired.
//   step 2  the agent CREATES + WIRES a kanban page via the SAME MCP path a spawned CC session
//           uses: connect the real MCP SDK client to the daemon's /mcp transport, vault.write the
//           kanban scaffold to panels/<slug>.html, then page.register(slug,title,path).
//           (The live prompt->agent->page leg is exercised + documented in scripts/vos-proof-vos228.ts;
//            the reaper SIGKILLs subagent CC trees mid-turn, so the deterministic proof drives the
//            agent's tool path here — the task explicitly allows this.)
//   step 3  the registered page appears as a leftNav row; clicking it opens the board.
//   step 4  the board renders the REAL task files as cards (titles match files on disk), bucketed
//           into the column matching each task's `state`. The scaffold's example cards are gone.
//   step 5  a vault.write edit to one task (via the MCP path) lands a CONFORMANT audit.jsonl line
//           AND the board regenerates LIVE via SSE — the changed card's text updates with NO reload
//           (we hold the same page object; the iframe reloads itself off the /p/:slug/stream event).
//   step 6  MUTATION (proof-falsifiability): break a load-bearing wire (corrupt the data-vos-source
//           glob so it points at an empty dir) and assert the board NO LONGER renders the real cards.
//           This proves the green assertions in steps 4-5 derive from real wiring, not always-true.
//
// Screenshots captured at each step under $VOS228_SHOT_DIR.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENV = JSON.parse(readFileSync(process.env.VOS228_ENV_OUT!, "utf8")) as {
  baseUrl: string; vault: string; tasksDir: string; deltaTaskPath: string;
  auditPath: string; mcpUrl: string; scaffoldPath: string;
};
const SHOT_DIR = process.env.VOS228_SHOT_DIR!;
const SLUG = "work-board";
const EXEC_ID = "exec-vos228-proof";

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOT_DIR, `vos228-${name}.png`), fullPage: true });

// One MCP client shared across the agent-path steps (the daemon's /mcp is the agent's tool surface).
async function mcpClient(): Promise<Client> {
  const client = new Client({ name: "vos228-proof-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENV.mcpUrl)));
  return client;
}

// Run the tests serially in one worker (the playwright config pins workers:1) so the page/board
// state built in earlier steps is observable in later steps.
test.describe.configure({ mode: "serial" });

test("step 1 — void-os dashboard + launch (type-a-prompt) surface is real and wired", async ({ page }) => {
  await page.goto(`${ENV.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".left-nav")).toBeVisible();
  // The prompt surface: a skill chip opens the launch modal with a real <textarea name=text> + POST /launch.
  const chips = page.locator(".skill-chip");
  expect(await chips.count()).toBeGreaterThan(0);
  await chips.first().click();
  await expect(page.locator("#launch-modal")).toBeVisible();
  await expect(page.locator("#lm-text")).toBeVisible();
  // The modal form really targets POST /launch (the prompt->agent entry the operator types into).
  const action = await page.locator("#launch-modal form").getAttribute("action");
  expect(action).toBe("/launch");
  // Type a real prompt asking the agent to build a board of the work tasks (documents the intent).
  await page.locator("#lm-text").fill("Create a kanban board of my work tasks under work/tasks/active.");
  await shot(page, "1-dashboard-prompt");
  await page.keyboard.press("Escape");
});

test("step 2 — agent creates + wires the kanban via the real MCP tool path (vault.write + page.register)", async () => {
  const client = await mcpClient();
  try {
    // The agent copies the kanban scaffold into panels/<slug>.html (vault.write), pointing its
    // data-vos-source at the work tasks dir (the scaffold ships that default), then registers it.
    const scaffold = readFileSync(ENV.scaffoldPath, "utf8");
    const w: any = await client.callTool({
      name: "vault.write",
      arguments: { path: `panels/${SLUG}.html`, content: scaffold, exec_id: EXEC_ID },
    });
    expect(w.isError, `vault.write isError: ${JSON.stringify(w.content)}`).toBeFalsy();
    const r: any = await client.callTool({
      name: "page.register",
      arguments: { slug: SLUG, title: "Work Board", path: `panels/${SLUG}.html`, exec_id: EXEC_ID },
    });
    expect(r.isError, `page.register isError: ${JSON.stringify(r.content)}`).toBeFalsy();
    // page.list (the agent's read-back) confirms the manifest upserted + pinned.
    const l: any = await client.callTool({ name: "page.list", arguments: {} });
    const pages = JSON.parse(l.content[0].text);
    const entry = pages.find((p: any) => p.slug === SLUG);
    expect(entry, "page.list missing the registered slug").toBeTruthy();
    expect(entry.pinned).toBe(true);
    expect(entry.path).toBe(`panels/${SLUG}.html`);
  } finally {
    await client.close();
  }
  // Provenance: page.register is audited as a vault.write on panels/manifest.json (§1.3).
  const audit = readFileSync(ENV.auditPath, "utf8");
  expect(audit).toContain(`"path":"panels/${SLUG}.html"`);
  expect(audit).toContain('"path":"panels/manifest.json"');
  expect(audit).toContain(`"exec":"${EXEC_ID}"`);
  expect(audit).toContain('"source":"mcp"');
});

test("step 3 — registered page appears in leftNav; clicking it opens the board", async ({ page }) => {
  await page.goto(`${ENV.baseUrl}/`, { waitUntil: "domcontentloaded" });
  const navRow = page.locator(`.nav-page[data-slug="${SLUG}"]`);
  await expect(navRow).toBeVisible();
  await expect(navRow).toContainText("Work Board");
  await shot(page, "2-leftnav-page-row");
  await navRow.click();
  await page.waitForURL(`**/p/${SLUG}`, { waitUntil: "domcontentloaded" });
  // The page shell wraps the board in an iframe (/p/:slug/body); the active nav row is highlighted.
  await expect(page.locator(`.nav-page.active[data-slug="${SLUG}"]`)).toBeVisible();
  await expect(page.locator("iframe#f")).toHaveCount(1);
  await shot(page, "3-board-opened");
});

test("step 4 — board renders the REAL task files as cards, bucketed by state; examples gone", async ({ page }) => {
  await page.goto(`${ENV.baseUrl}/p/${SLUG}`, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe#f");
  // Wait for a real card to appear inside the iframe (content selector, NOT networkidle).
  await frame.locator('.card[data-id="VOS-901"]').waitFor({ state: "visible", timeout: 15_000 });

  // Card titles match the files on disk.
  await expect(frame.locator('.card[data-id="VOS-901"]')).toContainText("Alpha onboarding flow");
  await expect(frame.locator('.card[data-id="VOS-902"]')).toContainText("Beta render seam");
  await expect(frame.locator('.card[data-id="VOS-903"]')).toContainText("Gamma audit trace");
  await expect(frame.locator('.card[data-id="VOS-904"]')).toContainText("Delta live regen");

  // Bucketed into the column whose data-col matches the task `state`.
  await expect(frame.locator('[data-col="todo"] .card[data-id="VOS-901"]')).toHaveCount(1);
  await expect(frame.locator('[data-col="doing"] .card[data-id="VOS-902"]')).toHaveCount(1);
  await expect(frame.locator('[data-col="done"] .card[data-id="VOS-903"]')).toHaveCount(1);

  // The scaffold's example cards are GONE (replaced by real data).
  await expect(frame.locator('text=Example task A')).toHaveCount(0);
  await expect(frame.locator('text=Example task B')).toHaveCount(0);

  // The cards derive from REAL files on disk (cross-check titles against the fs).
  const onDisk = readFileSync(ENV.deltaTaskPath, "utf8");
  expect(onDisk).toContain("title: Delta live regen");

  await shot(page, "4-real-cards-rendered");
});

test("step 5 — vault.write edit lands a conformant audit line AND regenerates the board live via SSE", async ({ page }) => {
  // Open the board and keep THIS page object (no reload) — the live update must arrive via SSE.
  await page.goto(`${ENV.baseUrl}/p/${SLUG}`, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe#f");
  await frame.locator('.card[data-id="VOS-904"]').waitFor({ state: "visible", timeout: 15_000 });
  await expect(frame.locator('.card[data-id="VOS-904"]')).toContainText("Delta live regen");

  const auditBefore = existsSync(ENV.auditPath) ? readFileSync(ENV.auditPath, "utf8") : "";
  const beforeLines = auditBefore ? auditBefore.trim().split("\n").length : 0;

  // The agent edits the task via the MCP write path (the audited, watched path).
  const NEW_TITLE = "Delta live regen — EDITED VIA MCP";
  const newContent = `---\nid: VOS-904\ntitle: ${NEW_TITLE}\nstate: doing\n---\n\n## Why\nedited by the VOS-228 proof.\n`;
  const client = await mcpClient();
  try {
    const w: any = await client.callTool({
      name: "vault.write",
      arguments: { path: "work/tasks/active/VOS-904-delta.md", content: newContent, exec_id: EXEC_ID },
    });
    expect(w.isError, `vault.write edit isError: ${JSON.stringify(w.content)}`).toBeFalsy();
  } finally {
    await client.close();
  }

  // (a) a NEW conformant audit line derives from the write.
  const auditAfter = readFileSync(ENV.auditPath, "utf8");
  const afterLines = auditAfter.trim().split("\n").length;
  expect(afterLines).toBeGreaterThan(beforeLines);
  const lastLine = JSON.parse(auditAfter.trim().split("\n").pop()!);
  expect(lastLine.tool).toBe("vault.write");
  expect(lastLine.path).toBe("work/tasks/active/VOS-904-delta.md");
  expect(lastLine.source).toBe("mcp");
  expect(lastLine.exec).toBe(EXEC_ID);
  expect(typeof lastLine.ts).toBe("number");
  expect(typeof lastLine.bytes).toBe("number");

  // (b) the board regenerates LIVE via SSE — the changed card's text updates with NO page reload.
  // The page-shell EventSource(/p/:slug/stream) fires on the data-source mtime advance, and the
  // iframe reloads itself off /p/:slug/body (which re-runs renderBoardData). We assert the NEW
  // title appears AND the card moved to the `doing` column (state changed todo->doing).
  await expect(frame.locator('.card[data-id="VOS-904"]')).toContainText(NEW_TITLE, { timeout: 20_000 });
  await expect(frame.locator('[data-col="doing"] .card[data-id="VOS-904"]')).toHaveCount(1);
  await expect(frame.locator('[data-col="todo"] .card[data-id="VOS-904"]')).toHaveCount(0);

  await shot(page, "5-live-sse-regen");
});

test("step 6 — MUTATION: break the data-vos-source wire → board no longer renders real cards (proof is falsifiable)", async ({ page }) => {
  // Corrupt the load-bearing wire: repoint data-vos-source at an empty dir. If the green assertions
  // above were always-true (not derived from real wiring), this would still render cards — it must NOT.
  const scaffold = readFileSync(ENV.scaffoldPath, "utf8");
  const broken = scaffold.replace(
    /data-vos-source="[^"]*"/,
    'data-vos-source="work/tasks/__nonexistent__/*.md"',
  );
  expect(broken).toContain('work/tasks/__nonexistent__');
  const client = await mcpClient();
  try {
    await client.callTool({
      name: "vault.write",
      arguments: { path: `panels/${SLUG}.html`, content: broken, exec_id: EXEC_ID },
    });
  } finally {
    await client.close();
  }

  await page.goto(`${ENV.baseUrl}/p/${SLUG}`, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe#f");
  // The board still renders (the panel html + columns), but with NO real cards (source is empty).
  await frame.locator('[data-col="todo"]').waitFor({ state: "visible", timeout: 15_000 });
  await expect(frame.locator('.card[data-id="VOS-901"]')).toHaveCount(0);
  await expect(frame.locator('.card[data-id="VOS-902"]')).toHaveCount(0);
  await expect(frame.locator('.card[data-id="VOS-903"]')).toHaveCount(0);
  await expect(frame.locator('.card[data-id="VOS-904"]')).toHaveCount(0);
  await shot(page, "6-mutation-no-cards");
});
