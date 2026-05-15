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
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),
  use: {
    headless: false,
  },
});
