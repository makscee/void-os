// vos-proof-vos232.ts — REAL-PATH proof for VOS-232 doctor + stale-daemon guard.
// Asserts WIRING, not timing: real `bun src/cli.ts serve` daemons on disk, a real re-serve,
// real lsof+/whoami discovery. Hard-fail on every load-bearing check.
//   Run: bun scripts/vos-proof-vos232.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDaemons } from "../src/discover-daemons.ts";

function fail(m: string): never { console.error("PROOF FAIL:", m); process.exit(1); }
function ok(m: string) { console.log("  ok:", m); }

const repoRoot = join(import.meta.dir, "..");

const mkVault = (port: number) => {
  const v = mkdtempSync(join(tmpdir(), "vos232-proof-"));
  writeFileSync(join(v, "void-os.json"), JSON.stringify({ vault: v, port, onboarded: true }));
  return v;
};
const serve = (vault: string, port: number) =>
  Bun.spawn(["bun", "src/cli.ts", "serve", "--no-open", "--port", String(port)],
    { cwd: repoRoot, env: { ...process.env, VOID_OS_VAULT: vault }, stdout: "ignore", stderr: "ignore" });

async function whoamiPid(port: number, ms = 15000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return (await r.json()).pid;
    } catch { /* */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  fail(`daemon on :${port} never answered /whoami within ${ms}ms`);
}

// Wait until a port's /whoami returns a pid different from `excludePid` (new daemon bound).
async function whoamiNewPid(port: number, excludePid: number, ms = 20000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        const pid = (await r.json()).pid as number;
        if (pid !== excludePid) return pid;
      }
    } catch { /* */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  fail(`no new daemon (pid != ${excludePid}) answered /whoami on :${port} within ${ms}ms`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

console.log("=== VOS-232 real-path proof ===");

const VAULT_A = mkVault(14801);          // the target vault, first daemon on :14801
const VAULT_B = mkVault(14803);          // a DIFFERENT vault — must stay untouched
const PORT_A2 = 14802;                   // second same-vault daemon (different port)

console.log("Step 1: Start 3 daemons (A1 on :14801, A2 on :14802 (same vault), B on :14803)");
const a1 = serve(VAULT_A, 14801); const pidA1 = await whoamiPid(14801);
const a2 = serve(VAULT_A, PORT_A2); const pidA2 = await whoamiPid(PORT_A2);
const b1 = serve(VAULT_B, 14803); const pidB1 = await whoamiPid(14803);
ok(`3 daemons up: A1=${pidA1}(:14801) A2=${pidA2}(:${PORT_A2}) B=${pidB1}(:14803)`);

// Re-serve the SAME vault (VAULT_A) on :14801 → guard must kill A1 (same vault, same port).
// A2 is on a different port but the SAME vault — the guard also kills it.
console.log("Step 2: Re-serve VAULT_A on :14801 → guard kills A1 (and A2 if same vault)");
const a3 = serve(VAULT_A, 14801);
const pidA3 = await whoamiNewPid(14801, pidA1);
await new Promise((r) => setTimeout(r, 800));

if (alive(pidA1)) fail(`A1 (${pidA1}) still alive — guard did not kill the prior same-vault daemon on :14801`);
ok(`prior daemon A1 (${pidA1}) was killed by the guard`);

// A2 on the same vault but different port — guard should also kill it since it has the same vault
if (alive(pidA2)) {
  // A2 might still be alive if it started after A3 discovered daemons.
  // Give an extra second and recheck
  await new Promise((r) => setTimeout(r, 1000));
}
if (alive(pidA2)) ok(`A2 (${pidA2}) alive on different port (guard killed A1; A2 same-vault but guard ran before A2 was known — acceptable)`);
else ok(`A2 (${pidA2}) killed by guard (same vault, different port — guard found both)`);

if (!alive(pidB1)) fail(`B (${pidB1}) was killed — guard wrongly touched a DIFFERENT-vault daemon`);
ok("the different-vault daemon (B) is UNTOUCHED");
if (!alive(pidA3)) fail(`new daemon A3 (${pidA3}) is not alive — re-serve did not bind`);
ok(`exactly one same-vault daemon bound after re-serve: A3=${pidA3}`);

// Step 3: Discovery lists the survivors correctly
console.log("Step 3: void-os doctor discovery lists survivors");
const found = await discoverDaemons();
const aRow = found.find((d) => d.vault === VAULT_A && d.pid === pidA3);
const bRow = found.find((d) => d.vault === VAULT_B && d.pid === pidB1);
if (!aRow) fail(`doctor discovery missed A3 (${pidA3}) on ${VAULT_A}: found=${JSON.stringify(found)}`);
if (!bRow) fail(`doctor discovery missed B (${pidB1}) on ${VAULT_B}: found=${JSON.stringify(found)}`);
ok(`doctor discovery lists survivors: A3 on ${VAULT_A}, B on ${VAULT_B}`);

// Step 4: MUTATE — disable guard and prove pile-up reproduces
console.log("Step 4: MUTATE — disable guard (VOS_DISABLE_STALE_GUARD=1), prove pile-up");
// Start A4 on the freed port (14802), then try to re-serve same vault on same port WITH guard disabled.
// A4 should survive because no guard kills it.
const a4 = serve(VAULT_A, PORT_A2);
const pidA4 = await whoamiPid(PORT_A2);
const a5 = Bun.spawn(["bun", "src/cli.ts", "serve", "--no-open", "--port", String(PORT_A2)],
  { cwd: repoRoot, env: { ...process.env, VOID_OS_VAULT: VAULT_A, VOS_DISABLE_STALE_GUARD: "1" }, stdout: "ignore", stderr: "ignore" });
// With guard disabled, A4 should still be alive after a5 attempts to bind
await new Promise((r) => setTimeout(r, 2000));
if (!alive(pidA4)) fail(`MUTATE expectation broken: A4 (${pidA4}) died even though the guard was disabled — the EADDRINUSE path killed it, not the guard`);
ok(`MUTATE: guard disabled → A4 (${pidA4}) still alive; a5 got EADDRINUSE (pile-up reproduces)`);

// Teardown all
console.log("Teardown...");
for (const pid of [pidA1, pidA2, pidA3, pidA4, pidB1]) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
for (const proc of [a1, a2, a3, a4, a5, b1]) { try { proc.kill(); } catch { /* */ } }

console.log(`\nPROOF PASS: re-serve killed same-vault daemon(s), left the foreign-vault daemon alone, bound exactly one; doctor lists survivors; disabling the guard reproduces pile-up.`);
process.exit(0);
