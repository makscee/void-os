// VOS-231 core-flow regression suite. Real Chromium, live daemon.
// Asserts WIRING (not LLM timing). Reads paths from the harness sidecar ($VOS_CORE_ENV_OUT).
// Three legs:
//   A — body.html write fires SSE reload; shell re-renders the iframe with NO manual refresh.
//   B — onboarding form: targetless form retargeted _self; submit POST→302 + body advances.
//   C — kanban page.register renders real task cards server-side + appears in leftNav.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENV = JSON.parse(readFileSync(process.env.VOS_CORE_ENV_OUT!, "utf8")) as {
  baseUrl: string;
  vault: string;
  sseUuid: string;
  sseBodyPath: string;
  onbUuid: string;
  onbBodyPath: string;
  tasksDir: string;
  mcpUrl: string;
  scaffoldPath: string;
};
const SHOT_DIR = process.env.VOS_CORE_SHOT_DIR!;
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOT_DIR, `core-${name}.png`), fullPage: true });

test.describe.configure({ mode: "serial" });

// ──────────────────────────────────────────────────────────────────
// Leg A — body.html write fires SSE reload (VOS-230 symptom-1 guard)
// ──────────────────────────────────────────────────────────────────
test("leg A — body.html write fires SSE reload; page re-renders the iframe with NO manual refresh", async ({
  page,
}) => {
  // Open a session that has NO body.html yet → renderShell emits no iframe#f (body-absent).
  await page.goto(`${ENV.baseUrl}/s/${ENV.sseUuid}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("iframe#f")).toHaveCount(0); // body absent → no iframe

  // Agent writes body.html on disk (the watched path). We do NOT reload the page; the live update
  // must arrive via the EventSource(/s/:uuid/stream) → render.ts onmessage → location.reload()
  // (iframe absent path — VOS-230 fix).
  const BODY = `<!doctype html><html><body><h1 id="live-marker">LIVE BODY WRITTEN</h1></body></html>`;
  writeFileSync(ENV.sseBodyPath, BODY);

  // After the SSE-driven shell reload, the iframe gets created and renders the new body.
  await expect(page.locator("iframe#f")).toHaveCount(1, { timeout: 20_000 });
  const frame = page.frameLocator("iframe#f");
  await expect(frame.locator("#live-marker")).toContainText("LIVE BODY WRITTEN");
  await shot(page, "A-sse-hot-reload");
});

// ──────────────────────────────────────────────────────────────────
// Leg B — onboarding form submit (VOS-230 symptom-2 guard)
// ──────────────────────────────────────────────────────────────────
test("leg B — onboarding form: targetless form is retargeted _self; submit lands POST→302 + advances body", async ({
  page,
}) => {
  // (a) the served body pipeline retargets the targetless <form> to _self (VOS-230 symptom-2 fix).
  // Without it the <base target=_top> makes the form target _top, which the sandbox blocks.
  const bodyHtml = await (await fetch(`${ENV.baseUrl}/s/${ENV.onbUuid}/body`)).text();
  expect(bodyHtml).toMatch(/<form\b[^>]*\btarget="_self"/i);

  // (b) drive a REAL submit in the iframe and assert the POST fires (302) — proves the form is wired,
  // not silently swallowed by a blocked top-navigation.
  await page.goto(`${ENV.baseUrl}/s/${ENV.onbUuid}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("iframe#f")).toHaveCount(1);
  const frame = page.frameLocator("iframe#f");
  await frame
    .locator(`form[action="/s/${ENV.onbUuid}/send"]`)
    .waitFor({ state: "visible", timeout: 15_000 });

  // Capture the POST as it fires. waitForResponse on the /send endpoint; 302 (redirect) is the effect.
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/s/${ENV.onbUuid}/send`) && r.request().method() === "POST",
      { timeout: 15_000 },
    ),
    frame.locator('button[type="submit"]').click(),
  ]);
  expect(resp.status()).toBe(302); // c.redirect(`/s/${uuid}`)

  // The send path also REWRITES body.html to workingPage(fields) — a real disk effect, no LLM.
  // workingPage outputs "received — working…" as the page title/header — anchor on that marker.
  const after = readFileSync(ENV.onbBodyPath, "utf8");
  expect(after).toContain("received — working"); // workingPage marker (render.ts:115 <h3>)
  await shot(page, "B-onboarding-submit");
});

// ──────────────────────────────────────────────────────────────────
// Leg C — kanban page.register → server-side card render (VOS-228 path guard)
// ──────────────────────────────────────────────────────────────────
const KANBAN_SLUG = "core-board";
const KANBAN_EXEC = "exec-vos231-core";

async function mcpClient(): Promise<Client> {
  const c = new Client({ name: "vos231-core", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(ENV.mcpUrl)));
  return c;
}

test("leg C — kanban page.register renders real task cards server-side + appears in leftNav (VOS-228 path)", async ({
  page,
}) => {
  const scaffold = readFileSync(ENV.scaffoldPath, "utf8");
  const client = await mcpClient();
  try {
    const w: any = await client.callTool({
      name: "vault.write",
      arguments: { path: `panels/${KANBAN_SLUG}.html`, content: scaffold, exec_id: KANBAN_EXEC },
    });
    expect(w.isError, `vault.write isError: ${JSON.stringify(w.content)}`).toBeFalsy();
    const r: any = await client.callTool({
      name: "page.register",
      arguments: {
        slug: KANBAN_SLUG,
        title: "Core Board",
        path: `panels/${KANBAN_SLUG}.html`,
        exec_id: KANBAN_EXEC,
      },
    });
    expect(r.isError, `page.register isError: ${JSON.stringify(r.content)}`).toBeFalsy();
  } finally {
    await client.close();
  }

  // Server-side render: GET /p/:slug/body renders the REAL task files as cards (titles from disk).
  const html = await (await fetch(`${ENV.baseUrl}/p/${KANBAN_SLUG}/body`)).text();
  expect(html).toContain("Alpha onboarding flow");
  expect(html).toContain("Beta render seam");
  expect(html).toContain("Gamma audit trace");
  expect(html).not.toContain("Example task A"); // scaffold examples stripped

  // The registered page appears as a leftNav row and opens the board in a real browser.
  await page.goto(`${ENV.baseUrl}/`, { waitUntil: "domcontentloaded" });
  const navRow = page.locator(`.nav-page[data-slug="${KANBAN_SLUG}"]`);
  await expect(navRow).toBeVisible();
  await navRow.click();
  await page.waitForURL(`**/p/${KANBAN_SLUG}`, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe#f");
  await frame.locator('.card[data-id="VOS-901"]').waitFor({ state: "visible", timeout: 15_000 });
  await expect(frame.locator('.card[data-id="VOS-901"]')).toContainText("Alpha onboarding flow");
  await shot(page, "C-kanban-render");
});
