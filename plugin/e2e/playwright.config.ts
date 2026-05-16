import { defineConfig } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Cold cache: globalSetup may download ~140MB Obsidian DMG + extract (≤5 min on slow link).
  // Warm cache: globalSetup overhead is unchanged (~5s).
  globalTimeout: 5 * 60_000,
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),
  use: {
    headless: false,
  },
});
