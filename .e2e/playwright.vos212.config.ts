import { defineConfig } from "@playwright/test";

// Minimal config for the VOS-212 finalizer render-only iframe-gate.
export default defineConfig({
  testDir: ".",
  testMatch: "vos212-iframe-gate.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
