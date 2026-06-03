import { defineConfig } from "@playwright/test";

// VOS-219 finalizer render-only inspect/sidebar gate.
export default defineConfig({
  testDir: ".",
  testMatch: "vos219-session-manager.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
