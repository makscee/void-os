import { defineConfig } from "@playwright/test";

// Minimal config for the VOS-214 Phase P2 S8 no-html wedged-case fixture suite.
export default defineConfig({
  testDir: ".",
  testMatch: "vos214-s8.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
