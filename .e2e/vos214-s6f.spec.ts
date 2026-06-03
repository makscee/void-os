// VOS-214 Phase 4 — S6 fixture spec
// Covers deterministic [fixture] steps only:
//   S6·t1 — iframe#f carries sandbox="allow-scripts allow-forms allow-popups"
//            AND does NOT contain "allow-same-origin" (null-origin enforcement).
//            REJECT if sandbox missing or allow-same-origin present (security regression).
//   S6·t2 — OPTIONS /s/:uuid/act → 204 + CORS headers permitting null-origin POST + htmx headers.
//
// S6·t3–t4 are [live] steps owned by the Phase 5 master-run script.
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.VOS214_S6F_BASE_URL!;
const SESSION = process.env.VOS214_S6F_SESSION!;
const SHOT_DIR = process.env.VOS214_S6F_SHOT_DIR!;

// truth JSON captured for the evidence record
const truth: Record<string, unknown> = {};
const TRUTH_OUT = process.env.VOS214_S6F_TRUTH_OUT!;

test.afterAll(() => {
  if (TRUTH_OUT) {
    writeFileSync(TRUTH_OUT, JSON.stringify(truth, null, 2));
  }
});

// ---------------------------------------------------------------------------
// S6·t1 — sandbox attribute: present, correct value, no allow-same-origin
// ---------------------------------------------------------------------------
test("S6·t1 iframe#f sandbox attr: allow-scripts allow-forms allow-popups, NO allow-same-origin", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/s/${SESSION}`, { waitUntil: "domcontentloaded" });

  // CORE: iframe#f must be present (real body.html was seeded)
  const iframe = page.locator("iframe#f");
  await expect(iframe).toHaveCount(1);

  // Read the sandbox attribute value
  const sandboxValue = await iframe.getAttribute("sandbox");

  // ACCEPT condition 1: sandbox attribute must exist
  expect(sandboxValue, "iframe#f must carry a sandbox attribute").not.toBeNull();

  // ACCEPT condition 2: exact value is "allow-scripts allow-forms allow-popups"
  expect(sandboxValue, "sandbox must equal 'allow-scripts allow-forms allow-popups'")
    .toBe("allow-scripts allow-forms allow-popups");

  // REJECT condition: allow-same-origin must be absent (null-origin enforcement)
  // If present → unsandboxed-iframe security regression → REJECT
  expect(
    sandboxValue!.includes("allow-same-origin"),
    "sandbox must NOT contain 'allow-same-origin' — would break null-origin isolation",
  ).toBe(false);

  truth["t1_sandbox"] = sandboxValue;
  truth["t1_accept"] = true;

  expect(pageErrors, `no page errors: ${pageErrors.join("; ")}`).toHaveLength(0);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(SHOT_DIR, "t1-sandbox.png"),
    fullPage: true,
  });
});

// ---------------------------------------------------------------------------
// S6·t2 — CORS preflight: OPTIONS /s/:uuid/act → 204 + required headers
// ---------------------------------------------------------------------------
test("S6·t2 OPTIONS /s/:uuid/act preflight: 204 + CORS headers + htmx headers", async ({ page }) => {
  // Navigate to any page so page.request is initialized
  await page.goto(`${BASE}/s/${SESSION}`, { waitUntil: "domcontentloaded" });

  const resp = await page.request.fetch(`${BASE}/s/${SESSION}/act`, {
    method: "OPTIONS",
    headers: {
      "Origin": "null",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, hx-request, hx-target",
    },
  });

  // Status must be 204
  expect(resp.status(), "OPTIONS /act must return 204").toBe(204);

  const headers = resp.headers();

  // Access-Control-Allow-Origin must be *
  expect(
    headers["access-control-allow-origin"],
    "Access-Control-Allow-Origin must be *",
  ).toBe("*");

  // Access-Control-Allow-Methods must include POST
  const allowMethods = headers["access-control-allow-methods"] ?? "";
  expect(
    allowMethods.includes("POST"),
    `Access-Control-Allow-Methods must include POST (got: ${allowMethods})`,
  ).toBe(true);

  // Access-Control-Allow-Headers must include hx-request and hx-target
  const allowHeaders = (headers["access-control-allow-headers"] ?? "").toLowerCase();
  expect(
    allowHeaders.includes("hx-request"),
    `Access-Control-Allow-Headers must include hx-request (got: ${allowHeaders})`,
  ).toBe(true);
  expect(
    allowHeaders.includes("hx-target"),
    `Access-Control-Allow-Headers must include hx-target (got: ${allowHeaders})`,
  ).toBe(true);

  truth["t2_status"] = resp.status();
  truth["t2_allow_origin"] = headers["access-control-allow-origin"];
  truth["t2_allow_methods"] = allowMethods;
  truth["t2_allow_headers"] = headers["access-control-allow-headers"];
  truth["t2_accept"] = true;
});
