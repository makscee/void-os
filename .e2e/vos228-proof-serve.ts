// VOS-228 THE PROOF — E2E harness (run under BUN).
//
// Boots a REAL void-os daemon (makeApp + Bun.serve) on a sandbox vault seeded with REAL task
// md files. Exposes the daemon URL + sandbox paths to the Playwright spec via env (printed as
// READY <url> + a JSON sidecar at $VOS228_ENV_OUT). The spec drives the actual void-os UI in a
// real browser; the agent's register+wire step is exercised through the SAME MCP code path a
// spawned CC session uses (callVaultTool / the /mcp transport), so the proof asserts WIRING.
//
// This harness is render+MCP-real: no live `vc`/claude/tmux (the live-CC prompt→agent→page leg
// is exercised + documented separately in scripts/vos-proof-vos228.ts, reaper-gated per the task).
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";

const VAULT = join(tmpdir(), "vos228-proof-vault");
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

// Seed REAL task md files under work/tasks/active/ — the kanban scaffold's default data-vos-source.
// One per board column (todo/doing/done) so column bucketing is exercised, plus a 4th to mutate.
const TDIR = join(VAULT, "work", "tasks", "active");
mkdirSync(TDIR, { recursive: true });
const seed = (file: string, id: string, title: string, state: string) =>
  writeFileSync(join(TDIR, file), `---\nid: ${id}\ntitle: ${title}\nstate: ${state}\n---\n\n## Why\nseed task for VOS-228 proof.\n`);
seed("VOS-901-alpha.md", "VOS-901", "Alpha onboarding flow", "todo");
seed("VOS-902-beta.md", "VOS-902", "Beta render seam", "doing");
seed("VOS-903-gamma.md", "VOS-903", "Gamma audit trace", "done");
seed("VOS-904-delta.md", "VOS-904", "Delta live regen", "todo"); // the card the spec edits via vault.write

// Seed a vault skill so the dashboard renders a launch chip → the type-a-prompt modal is reachable
// (the prompt surface the operator types into; the proof exercises it in step 1).
const SKILLDIR = join(VAULT, ".claude", "skills", "make-board");
mkdirSync(SKILLDIR, { recursive: true });
writeFileSync(
  join(SKILLDIR, "SKILL.md"),
  `---\nname: make-board\ndescription: Create a kanban board of the work tasks.\nversion: 1.0.0\n---\n\nUse page.register to wire a kanban scaffold at the tasks dir.\n`,
);

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });
const baseUrl = `http://127.0.0.1:${server.port}`;

// Sidecar env file so the spec (running under node/playwright, separate process) gets the paths.
const envOut = process.env.VOS228_ENV_OUT ?? join(tmpdir(), "vos228-proof-env.json");
writeFileSync(
  envOut,
  JSON.stringify({
    baseUrl,
    vault: VAULT,
    tasksDir: TDIR,
    deltaTaskPath: join(TDIR, "VOS-904-delta.md"),
    auditPath: join(VAULT, ".void-os", "audit.jsonl"),
    mcpUrl: `${baseUrl}/mcp`,
    scaffoldPath: join(import.meta.dir, "..", "kit", "scaffolds", "kanban.html"),
  }, null, 2),
);

console.log(`READY ${baseUrl}`);
console.log(`[harness] vault=${VAULT}`);
console.log(`[harness] env sidecar=${envOut}`);
void existsSync; // keep import used across edits
