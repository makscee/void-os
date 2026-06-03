import { defineConfig } from "@playwright/test";

// VOS-214 Phase-3 playwright config — S5 attach/resume-command fixture steps.
export default defineConfig({
  testDir: ".",
  testMatch: "vos214-s5.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});
