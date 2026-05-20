// plugin/e2e/helpers/layout-check.ts
//
// VOS-163: layout-drift guards for the operator-journey spec.
//   assertBox  — first-run / no-baseline guard: the surface exists, is
//                on-screen, and has a non-zero box.
//   layoutShot — toHaveScreenshot regression gate, tolerant of font AA.
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Coarse layout guard usable BEFORE any screenshot baseline exists.
 * Asserts the located surface is visible with a non-zero box that sits
 * inside the viewport — catches gross layout breakage (collapsed /
 * off-screen surface) on the very first run. Returns the box.
 */
export async function assertBox(
  page: Page,
  locator: Locator,
  label: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator, `${label}: surface must be visible`).toBeVisible({
    timeout: 15_000,
  });
  const box = await locator.boundingBox();
  expect(box, `${label}: boundingBox null`).not.toBeNull();
  const b = box!;
  expect(b.width, `${label}: zero width`).toBeGreaterThan(0);
  expect(b.height, `${label}: zero height`).toBeGreaterThan(0);
  const vp = page.viewportSize() ?? { width: 99_999, height: 99_999 };
  expect(b.x, `${label}: off-screen left`).toBeGreaterThanOrEqual(-2);
  expect(b.y, `${label}: off-screen top`).toBeGreaterThanOrEqual(-2);
  expect(b.x, `${label}: off-screen right`).toBeLessThan(vp.width);
  expect(b.y, `${label}: off-screen bottom`).toBeLessThan(vp.height);
  return b;
}

/**
 * Screenshot-diff regression gate. On the first run Playwright writes the
 * baseline (and throws "A snapshot doesn't exist" — the caller treats that
 * as a first-run verdict, not a failure). Thereafter it pixel-diffs.
 *
 * `maxDiffPixelRatio` defaults to 0.02 — enough to absorb Obsidian font /
 * anti-aliasing noise. Surfaces whose CONTENT legitimately varies run to
 * run (e.g. the inspector trace, whose width tracks variable-length agent
 * / task ids) pass a looser ratio: the goal is to catch LAYOUT drift —
 * collapsed panes, mis-stacked chrome — not pixel-identical content.
 */
export async function layoutShot(
  locator: Locator,
  name: string,
  maxDiffPixelRatio = 0.02,
): Promise<void> {
  await expect(locator).toHaveScreenshot(`${name}.png`, {
    maxDiffPixelRatio,
    animations: "disabled",
  });
}
