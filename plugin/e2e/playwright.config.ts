import { defineConfig } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// VOS-107 T9: split into two Playwright projects.
//   * `main` — all baseline specs; uses the shared globalSetup daemon
//     (VOS_FAKE_SCRIPT_maya = ask-agent/maya.jsonl). Excludes ask-user.spec.ts.
//   * `ask-user` — runs ONLY ask-user.spec.ts against a dedicated daemon
//     whose VOS_FAKE_SCRIPT_maya points at ask-user.jsonl (so the maya
//     agent emits a vos_ask_user directive instead of an ask_agent
//     tool_use). State sidecar is exposed via VOS_E2E_STATE_ASK_USER.
//
// Both top-level globalSetup/Teardown chains run sequentially: the shared
// daemon comes up for the `main` project, and (chained) a second daemon
// for the `ask-user` project. Playwright runs both projects on a single
// worker (fullyParallel: false, workers: 1) so the two daemons never
// contend for the same Obsidian instance — they each have their own.
export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Cold cache: globalSetup may download ~140MB Obsidian DMG + extract (≤5 min on slow link).
  // Two projects, each spawning their own daemon + Obsidian — bump the cap.
  globalTimeout: 10 * 60_000,
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "globalSetup-all.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown-all.ts"),
  projects: [
    {
      name: "main",
      testIgnore: ["**/ask-user.spec.ts"],
    },
    {
      name: "ask-user",
      testMatch: ["**/ask-user.spec.ts"],
    },
  ],
  use: {
    headless: false,
  },
});
