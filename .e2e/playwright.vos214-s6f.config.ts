import { defineConfig } from "@playwright/test";

// Minimal config for the VOS-214 Phase 4 — S6 fixture (sandbox attr + CORS preflight).
export default defineConfig({
  testDir: ".",
  testMatch: "vos214-s6f.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
