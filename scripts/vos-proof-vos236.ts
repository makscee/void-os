#!/usr/bin/env bun
/**
 * VOS-236 real-path proof: serve no-auto-open opt-in.
 *
 * Asserts:
 *  A) shouldOpenBrowser([]) === false  (default = no open)
 *  B) shouldOpenBrowser(["--open"]) === true  (opt-in)
 *  C) shouldOpenBrowser(["--no-open"]) === false  (back-compat no-op)
 *  D) MUTATE: patch serve.ts to revert to opt-out → bare serve opens browser
 *     (shouldOpenBrowser mock flips) → restore → bare serve silent again.
 *
 * Hard-fail on any assertion.
 */

import { shouldOpenBrowser } from "../src/serve.ts";
import { readFileSync, writeFileSync } from "node:fs";

let PASS = 0;
let FAIL = 0;

function assert(label: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL  ${label}`);
    FAIL++;
  }
}

// ---- A: default (no flags) → shouldOpenBrowser returns false ----
console.log("\n[A] Default no-flags — shouldOpenBrowser must return false");
assert("shouldOpenBrowser([]) === false", shouldOpenBrowser([]) === false);
assert("shouldOpenBrowser(['serve', '--port', '4317']) === false",
  shouldOpenBrowser(["serve", "--port", "4317"]) === false);

// ---- B: --open flag → returns true ----
console.log("\n[B] --open flag — shouldOpenBrowser must return true");
assert("shouldOpenBrowser(['--open']) === true", shouldOpenBrowser(["--open"]) === true);
assert("shouldOpenBrowser(['serve', '--port', '5000', '--open']) === true",
  shouldOpenBrowser(["serve", "--port", "5000", "--open"]) === true);

// ---- C: --no-open is harmless no-op (still false) ----
console.log("\n[C] --no-open back-compat — shouldOpenBrowser must return false");
assert("shouldOpenBrowser(['--no-open']) === false", shouldOpenBrowser(["--no-open"]) === false);
// --no-open overrides --open
assert("shouldOpenBrowser(['--open', '--no-open']) === false",
  shouldOpenBrowser(["--open", "--no-open"]) === false);

// ---- D: MUTATE — swap logic to opt-out and verify the function flips ----
console.log("\n[D] MUTATE: replace shouldOpenBrowser body to opt-out logic");
const SERVE_PATH = new URL("../src/serve.ts", import.meta.url).pathname;
const original = readFileSync(SERVE_PATH, "utf8");

// Mutate: replace opt-in body with opt-out body
const mutated = original.replace(
  "  if (argv.includes(\"--no-open\")) return false;\n  return argv.includes(\"--open\");",
  "  const noOpen = argv.includes(\"--no-open\");\n  return !noOpen;",
);

if (mutated === original) {
  console.error("  FAIL  MUTATE: patch did not apply — string not found");
  FAIL++;
} else {
  writeFileSync(SERVE_PATH, mutated);
  console.log("  MUTATE applied (opt-out mode)");

  // Re-import the mutated module to exercise the new logic
  // Bun caches modules, so we use dynamic exec in a subprocess
  const mutateCheck = Bun.spawnSync(["bun", "-e", `
    const { shouldOpenBrowser } = await import("${SERVE_PATH}?bust=${Date.now()}");
    // With opt-out: no-flag should return true (opens by default)
    const noFlagResult = shouldOpenBrowser([]);
    // With opt-out: --no-open should return false
    const noOpenResult = shouldOpenBrowser(["--no-open"]);
    process.stdout.write(JSON.stringify({ noFlagResult, noOpenResult }));
  `], { stdout: "pipe", stderr: "pipe" });

  const output = mutateCheck.stdout.toString().trim();
  let parsed: { noFlagResult: boolean; noOpenResult: boolean } | null = null;
  try { parsed = JSON.parse(output); } catch { /* */ }

  if (parsed) {
    assert("MUTATE: shouldOpenBrowser([]) === true (opt-out default opens)", parsed.noFlagResult === true);
    assert("MUTATE: shouldOpenBrowser(['--no-open']) === false", parsed.noOpenResult === false);
  } else {
    console.error("  FAIL  MUTATE subprocess output:", output, mutateCheck.stderr.toString());
    FAIL++;
  }

  // Restore
  writeFileSync(SERVE_PATH, original);
  console.log("  RESTORE applied (opt-in mode restored)");

  // Verify restored
  const restoreCheck = Bun.spawnSync(["bun", "-e", `
    const { shouldOpenBrowser } = await import("${SERVE_PATH}?bust2=${Date.now()}");
    process.stdout.write(JSON.stringify({ result: shouldOpenBrowser([]) }));
  `], { stdout: "pipe", stderr: "pipe" });
  const restOut = restoreCheck.stdout.toString().trim();
  let restParsed: { result: boolean } | null = null;
  try { restParsed = JSON.parse(restOut); } catch { /* */ }
  if (restParsed) {
    assert("RESTORE: shouldOpenBrowser([]) === false again", restParsed.result === false);
  } else {
    console.error("  FAIL  RESTORE check output:", restOut);
    FAIL++;
  }
}

// ---- Summary ----
console.log(`\n=== VOS-236 proof: ${PASS} passed, ${FAIL} failed ===`);
if (FAIL > 0) {
  process.exit(1);
}
