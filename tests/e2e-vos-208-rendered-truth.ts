/**
 * VOS-208 rendered-truth dump — captures getComputedStyle backgroundColor + bbox
 * for each status dot from a live browser, writes a truth JSON for tools/master/rendered-check.
 * Seeds the SAME real registry rows as e2e-vos-208-status-dot.ts.
 * Run: bun run tests/e2e-vos-208-rendered-truth.ts
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openRegistry, createExecution, setExecutionEnded, setExecutionFail } from "../src/registry.ts";
import { bodyPath, sessionDir, reapedPath, stopPath } from "../src/paths.ts";

const WORKTREE = "/Users/admin/void-os-wt/VOS-208";
const VAULT = "/tmp/void-os-rt-vos208";
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const TRUTH = "/tmp/vos-208-rendered-truth.json";
const BUN = process.execPath;

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "sessions"), { recursive: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({
  vault: VAULT, onboarded: true, skills: [], answers: {}, port: PORT,
  runners: [{ label: "fake", command: "echo --" }], defaultRunner: "fake",
}, null, 2));

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const now = Date.now();
const seed = (uuid: string, body: string) => { mkdirSync(sessionDir(VAULT, uuid), { recursive: true }); writeFileSync(bodyPath(VAULT, uuid), body); };
const mkExec = (uuid: string, t: number) => createExecution(db, { id: uuid, agent: null, skill: null, inputRef: null, tmuxSession: `vos-run-${uuid}`, now: t, triggerId: null, stepCeiling: null });

seed("s-error", `<title>failed</title><p>o</p>`); mkExec("s-error", now - 10000); setExecutionFail(db, "s-error", "runaway-ceiling", now - 5000);
seed("s-reaped", `<title>reaped</title><p>o</p>`); mkExec("s-reaped", now - 20000); setExecutionEnded(db, "s-reaped", now - 10000); writeFileSync(reapedPath(VAULT, "s-reaped"), "reaped\n");
seed("s-stopped", `<title>stopped</title><p>o</p>`); mkExec("s-stopped", now - 30000); setExecutionEnded(db, "s-stopped", now - 15000); writeFileSync(stopPath(VAULT, "s-stopped"), "stopped\n");
seed("s-await", `<title>awaiting</title><form action='/s/s-await/send' method='POST'><input name='v'><button>Accept</button></form>`); mkExec("s-await", now - 5000);
seed("s-working", `<title>working</title><p>p…</p>`); mkExec("s-working", now - 3000);
seed("s-complete", `<title>complete</title><p>done</p>`); mkExec("s-complete", now - 40000); setExecutionEnded(db, "s-complete", now - 35000);
db.close();

const server = spawn(BUN, ["run", "src/cli.ts", "serve", "--no-open"], {
  cwd: WORKTREE, env: { ...process.env, VOID_OS_VAULT: VAULT, VOID_OS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
await new Promise<void>((r) => setTimeout(r, 3000));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let exitCode = 0;
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector(".session-list", { timeout: 8000 });

  const dump = async (uuid: string) => page.$eval(`a[href="/s/${uuid}"] .session-dot`, (el) => {
    const cs = getComputedStyle(el as Element);
    const r = (el as Element).getBoundingClientRect();
    return { backgroundColor: cs.backgroundColor, width: r.width, height: r.height };
  });

  const states = ["s-error", "s-reaped", "s-stopped", "s-await", "s-working", "s-complete"];
  const computed: Record<string, string | number> = {};
  const colors: Record<string, string> = {};
  for (const s of states) {
    const d = await dump(s);
    computed[`${s}.bg`] = d.backgroundColor;
    computed[`${s}.w`] = d.width;
    computed[`${s}.h`] = d.height;
    colors[s] = d.backgroundColor;
  }
  // Assert distinctness: error/reaped/stopped/await must each differ from working(green) & complete(green)
  const green = colors["s-working"];
  for (const s of ["s-error", "s-reaped", "s-stopped", "s-await"]) {
    if (colors[s] === green) { console.error(`RENDERED-TRUTH FAIL: ${s} dot same color as green working dot (${green})`); exitCode = 1; }
  }
  if (colors["s-complete"] !== green) { console.error(`RENDERED-TRUTH FAIL: complete (${colors["s-complete"]}) != working green (${green})`); exitCode = 1; }

  writeFileSync(TRUTH, JSON.stringify({ computed }, null, 2));
  console.log("Rendered dot colors:", JSON.stringify(colors, null, 2));
  console.log("Truth written:", TRUTH);
} catch (err) {
  console.error("RENDERED-TRUTH ERROR:", err);
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  process.exit(exitCode);
}
