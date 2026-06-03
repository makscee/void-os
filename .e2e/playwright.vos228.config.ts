import { defineConfig } from "@playwright/test";

// VOS-228 THE PROOF — kanban end-to-end gate. Real Chromium against a bun-served live daemon.
// Serial single-worker so the page/board state from earlier steps is observable in later ones.
export default defineConfig({
  testDir: ".",
  testMatch: "vos228-kanban-proof.spec.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
