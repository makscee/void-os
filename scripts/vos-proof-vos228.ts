#!/usr/bin/env bun
// vos-proof-vos228.ts — VOS-228 P4 LIVE-CC leg of THE PROOF.
//
// The deterministic gate (.e2e/vos228-kanban-proof.spec.ts) drives the agent's register+wire
// step through the SAME MCP transport a spawned CC session uses, so it asserts WIRING without
// model-timing flakiness. THIS script closes the remaining gap the task calls out: the
// prompt -> agent -> page leg must be exercised at least once with a REAL `claude` session.
//
// What it does, against a LIVE daemon, with NO deterministic shortcut for the register step:
//   1. boot the real daemon (makeApp + Bun.serve) on a sandbox vault seeded with the kanban
//      scaffold under panels/ + real task files (so the agent has something to point at).
//   2. generate the per-session .mcp.json via the SAME writeSessionMcpConfig the spawn path
//      calls (server key "void-os-vault", url .../mcp) — no hardcoding.
//   3. run a REAL `claude -p` turn with the SAME flags the daemon's spawn path uses
//      (--add-dir <vault> --permission-mode bypassPermissions --mcp-config <gen> --strict-mcp-config),
//      prompting the agent (in plain English) to register a kanban board page.
//   4. assert the LLM, given only the prompt + the MCP tools, called page.register — i.e. the
//      manifest now pins a page whose path points at a panel under the vault. The board then
//      serves live via GET /p/:slug/body with the real task cards.
//
// Reaper note: void-os SIGKILLs spawned CC process trees at ~2-4 min; a `claude -p` turn that
// reasons + calls a tool usually returns well under that, but if the relay/CC stalls past
// PROOF_TIMEOUT_MS the script kills the child and exits with a REAPER-GATED marker (non-zero)
// — it never silently "passes" without the live tool call. The deterministic gate is the
// always-green CI signal; this is the once-exercised live confirmation.
//
// Run: VOS228_LIVE=1 bun scripts/vos-proof-vos228.ts   (requires `vc`/claude authed + reachable)
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { writeSessionMcpConfig } from "../src/session-mcp-config.ts";

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function pass(msg: string) { console.log(`PASS: ${msg}`); }

const PROOF_TIMEOUT_MS = Number(process.env.VOS228_PROOF_TIMEOUT_MS ?? 180_000);
const PORT = 4392; // unlikely to collide with a running daemon

// ── step 1: sandbox vault with the kanban scaffold + real tasks ──
const vault = mkdtempSync(join(tmpdir(), "vos-228-live-"));
mkdirSync(join(vault, ".void-os"), { recursive: true });
const tdir = join(vault, "work", "tasks", "active");
mkdirSync(tdir, { recursive: true });
const seed = (file: string, id: string, title: string, state: string) =>
  writeFileSync(join(tdir, file), `---\nid: ${id}\ntitle: ${title}\nstate: ${state}\n---\n\n## Why\nlive-proof task.\n`);
seed("VOS-901-alpha.md", "VOS-901", "Alpha onboarding flow", "todo");
seed("VOS-902-beta.md", "VOS-902", "Beta render seam", "doing");
seed("VOS-903-gamma.md", "VOS-903", "Gamma audit trace", "done");
// Pre-stage the kanban scaffold under panels/ so the agent only needs to REGISTER it (keeps the
// live turn short + within the reaper window — the scaffold authoring itself is exercised by the
// deterministic gate's vault.write step). The load-bearing live assertion is the page.register call.
const panels = join(vault, "panels");
mkdirSync(panels, { recursive: true });
const scaffold = readFileSync(join(import.meta.dir, "..", "kit", "scaffolds", "kanban.html"), "utf8");
writeFileSync(join(panels, "work-board.html"), scaffold);

const db = openRegistry(":memory:");
const app = makeApp(vault, db);
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });
console.log(`[proof] daemon live at http://127.0.0.1:${PORT}, vault=${vault}`);

const manifestPath = join(vault, "panels", "manifest.json");

(async () => {
  // ── step 2: generate the session .mcp.json the spawn path generates ──
  const runId = "exec-vos228-live";
  const cfgPath = writeSessionMcpConfig(vault, runId, PORT, null);
  if (!existsSync(cfgPath)) fail(`session .mcp.json not generated at ${cfgPath}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const entry = cfg.mcpServers?.["void-os-vault"];
  if (!entry || entry.type !== "http" || !entry.url) fail(`generated config missing void-os-vault http entry`);
  pass(`session .mcp.json generated, void-os-vault → ${entry.url}`);

  // ── step 3: run a REAL claude -p turn with the daemon's spawn flags + a plain-English prompt ──
  const prompt = [
    "You are a void-os agent. There is a kanban panel already authored at panels/work-board.html",
    "in this vault (it renders the work tasks under work/tasks/active). Register it as a pinned page",
    'so it appears in the dashboard left-nav. Use the MCP tool page.register with slug "work-board",',
    'title "Work Board", and path "panels/work-board.html". Call the tool — do not just describe it.',
  ].join(" ");

  // Same flags spawn.ts uses for a print-mode MCP turn (see buildLaunchArgv / spawnTurn).
  const claudeArgs = [
    "--raw", "--",
    "--add-dir", vault,
    "--permission-mode", "bypassPermissions",
    "--mcp-config", cfgPath,
    "--strict-mcp-config",
    "-p", prompt,
  ];
  console.log(`[proof] launching real CC turn: vc ${claudeArgs.join(" ")}`);
  const proc = Bun.spawn(["vc", ...claudeArgs], { cwd: vault, stdout: "pipe", stderr: "pipe" });

  const timer = setTimeout(() => {
    console.error(`[proof] REAPER-GATED: live CC turn exceeded ${PROOF_TIMEOUT_MS}ms; killing.`);
    try { proc.kill(); } catch { /* ignore */ }
  }, PROOF_TIMEOUT_MS);

  const exit = await proc.exited;
  clearTimeout(timer);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  console.log(`[proof] CC turn exited ${exit}`);
  if (out.trim()) console.log(`[proof] --- claude stdout (tail) ---\n${out.slice(-1200)}`);
  if (err.trim()) console.log(`[proof] --- claude stderr (tail) ---\n${err.slice(-600)}`);

  // ── step 4: assert the LLM actually CALLED page.register (manifest pins the page) ──
  if (!existsSync(manifestPath)) {
    fail(`live CC turn did NOT register a page — panels/manifest.json absent. ` +
      `(If this is a reaper/relay stall the exit was non-zero; the deterministic gate remains the CI signal.)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const page = (manifest.pages ?? []).find((p: any) => p.slug === "work-board");
  if (!page) fail(`manifest has no work-board page after the live turn: ${JSON.stringify(manifest)}`);
  if (page.path !== "panels/work-board.html") fail(`registered path wrong: ${page.path}`);
  if (page.pinned !== true) fail(`registered page not pinned: ${JSON.stringify(page)}`);
  pass(`LIVE CC agent called page.register from the prompt → manifest pins work-board → panels/work-board.html`);

  // the registered board serves live with the REAL task cards
  const bodyRes = await fetch(`http://127.0.0.1:${PORT}/p/work-board/body`);
  if (bodyRes.status !== 200) fail(`GET /p/work-board/body status ${bodyRes.status}`);
  const html = await bodyRes.text();
  if (!html.includes("Alpha onboarding flow")) fail(`board did not render the real task cards`);
  if (html.includes("Example task A") || html.includes("Example task B")) fail(`scaffold example cards leaked into the live board`);
  pass(`GET /p/work-board/body renders the REAL task cards (examples stripped) — prompt→agent→page proven live`);

  console.log("\nALL PASS — VOS-228 live-CC leg: a real claude session, given only the prompt + the daemon MCP tools, registered the page and the board renders the real tasks.");
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { server.stop(true); });
