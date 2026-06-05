#!/usr/bin/env bun
/**
 * VOS-236 REAL-PATH proof: spawn a real `void-os serve` daemon and observe
 * whether it spawns a real opener child (`open`/`xdg-open`) along its
 * production path — not the shouldOpenBrowser predicate in isolation.
 *
 * Method: shim `open` + `xdg-open` onto a temp PATH dir as no-op scripts that
 * append a line to a marker file. Bun.spawn(["open"|"xdg-open", url]) resolves
 * via PATH, so the shim is hit iff the daemon actually launches the opener.
 *
 * Arms:
 *   A) bare `serve`        → marker MUST stay empty (no opener child)
 *   B) `serve --open`      → marker MUST contain one opener invocation
 *   C) `serve --no-open`   → marker MUST stay empty (back-compat no-op)
 *   D) MUTATE serve.ts to opt-out → bare serve MUST now spawn opener (proves
 *      the marker actually fires when wiring opens) → restore → bare silent.
 *
 * Hard-fail (exit 1) on any assertion. Asserts WIRING (real child spawn),
 * not predicate return values, not LLM timing.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let PASS = 0, FAIL = 0;
function assert(label: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${label}`); PASS++; }
  else { console.error(`  FAIL  ${label}`); FAIL++; }
}

const SERVE_PATH = new URL("../src/serve.ts", import.meta.url).pathname;
const BIN = new URL("../bin/void-os", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "vos236-rp-"));
const shimDir = join(work, "bin");
const marker = join(work, "opener.marker");
const vault = join(work, "vault");

// Build PATH shims for both opener names. Each appends "$0 $@" to the marker.
import { mkdirSync } from "node:fs";
mkdirSync(shimDir, { recursive: true });
mkdirSync(vault, { recursive: true });
for (const name of ["open", "xdg-open"]) {
  const p = join(shimDir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 0\n`);
  chmodSync(p, 0o755);
}

const baseEnv = {
  ...process.env,
  PATH: `${shimDir}:${process.env.PATH}`,
  VOID_OS_VAULT: vault,
  HOME: work,
};

// serve aborts early ("no void-os vault — run init first") unless the vault is
// initialized, so the daemon must be init'd before it can reach the opener line.
const initProc = Bun.spawnSync([BIN, "init", vault], { env: baseEnv, stdout: "pipe", stderr: "pipe", cwd: work });
if (initProc.exitCode !== 0) {
  console.error("  FAIL  vault init failed:", initProc.stderr.toString());
  process.exit(1);
}

async function runServeOnce(args: string[], port: number): Promise<void> {
  if (existsSync(marker)) rmSync(marker);
  const proc = Bun.spawn([BIN, "serve", "--port", String(port), ...args], {
    env: baseEnv, stdout: "pipe", stderr: "pipe", cwd: work,
  });
  // Give the daemon time to bind + reach the opener decision point.
  await Bun.sleep(3000);
  proc.kill();
  await proc.exited;
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  console.log(`    [daemon ${args.join(" ") || "(bare)"} :${port}] ${out.trim().split("\n").slice(0, 2).join(" | ")}`);
}

function markerHits(): number {
  if (!existsSync(marker)) return 0;
  const t = readFileSync(marker, "utf8").trim();
  return t === "" ? 0 : t.split("\n").length;
}

console.log("\n[A] bare `serve` — real daemon must NOT spawn opener child");
await runServeOnce([], 47361);
assert("bare serve: 0 opener-child invocations", markerHits() === 0);

console.log("\n[B] `serve --open` — real daemon MUST spawn opener child");
await runServeOnce(["--open"], 47362);
assert("serve --open: >=1 opener-child invocation", markerHits() >= 1);

console.log("\n[C] `serve --no-open` — back-compat no-op, MUST stay silent");
await runServeOnce(["--no-open"], 47363);
assert("serve --no-open: 0 opener-child invocations", markerHits() === 0);

console.log("\n[D] MUTATE serve.ts to opt-out — bare serve MUST now spawn opener");
const original = readFileSync(SERVE_PATH, "utf8");
const mutated = original.replace(
  '  if (argv.includes("--no-open")) return false;\n  return argv.includes("--open");',
  '  const noOpen = argv.includes("--no-open");\n  return !noOpen;',
);
if (mutated === original) {
  console.error("  FAIL  MUTATE: patch string not found in serve.ts");
  FAIL++;
} else {
  writeFileSync(SERVE_PATH, mutated);
  // The on-disk rewrite invalidates Bun's transpile cache; the next daemon
  // cold-transpiles serve.ts, so give it extra warmup before the opener check.
  await Bun.sleep(500);
  try {
    await runServeOnce([], 47364);
    assert("MUTATE opt-out: bare serve NOW spawns opener (>=1)", markerHits() >= 1);
  } finally {
    writeFileSync(SERVE_PATH, original);
    console.log("  RESTORE applied (opt-in restored)");
  }
  await runServeOnce([], 47365);
  assert("RESTORE: bare serve silent again (0)", markerHits() === 0);
}

rmSync(work, { recursive: true, force: true });
console.log(`\n=== VOS-236 REAL-PATH proof: ${PASS} passed, ${FAIL} failed ===`);
if (FAIL > 0) process.exit(1);
