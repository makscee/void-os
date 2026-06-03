// VOS-231 core-flow regression gate. Real Chromium, live daemon.
// Serial single-worker so disk/SSE state from earlier legs is observable in later ones.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "core-flows.spec.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
