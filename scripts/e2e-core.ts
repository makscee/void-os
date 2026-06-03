#!/usr/bin/env bun
// scripts/e2e-core.ts — single-command core-flow gate (VOS-231).
// Boots the serve harness, awaits READY, runs the playwright config against it, propagates exit code,
// tears the harness down in finally.
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_OUT = join(tmpdir(), "vos231-core-env.json");
const SHOT_DIR = process.env.VOS_CORE_SHOT_DIR ?? join(tmpdir(), "vos231-core-shots");
const ROOT = join(import.meta.dir, "..");

const harness = Bun.spawn(["bun", ".e2e/core-flows-serve.ts"], {
  cwd: ROOT,
  env: { ...process.env, VOS_CORE_ENV_OUT: ENV_OUT },
  stdout: "pipe",
  stderr: "inherit",
});

// Await "READY <url>" on the harness stdout (bounded — hard-fail if it never readies).
async function awaitReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const reader = harness.stdout!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    if (/\bREADY http/.test(buf)) {
      reader.releaseLock();
      return;
    }
  }
  throw new Error("harness never printed READY within timeout");
}

let code = 1;
try {
  await awaitReady();
  const pw = Bun.spawn(
    ["bunx", "playwright", "test", "-c", ".e2e/playwright.core.config.ts"],
    {
      cwd: ROOT,
      env: { ...process.env, VOS_CORE_ENV_OUT: ENV_OUT, VOS_CORE_SHOT_DIR: SHOT_DIR },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  code = await pw.exited;
} catch (e) {
  console.error(`[e2e:core] ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  try {
    harness.kill();
  } catch {
    /* ignore */
  }
}
process.exit(code);
