import { defineConfig } from "@playwright/test";

// Minimal config for the VOS-210 finalizer render-only gate.
export default defineConfig({
  testDir: ".",
  testMatch: "vos210-chat-first.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
