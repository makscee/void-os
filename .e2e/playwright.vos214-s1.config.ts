import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "**/vos214-s1.spec.ts",
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
});
