// VOS-231 core-flow regression harness (run under BUN).
// Boots the REAL void-os daemon (makeApp + Bun.serve, free port) on a fresh tmpdir vault and
// seeds fixtures for the 3 core flows. Render+MCP-real: NO live vc/claude/tmux.
//   leg A (SSE hot-reload): a session opened with NO body.html (hasBody=false → no iframe#f).
//   leg B (onboarding submit): a session whose body.html holds a native <form method=POST
//     action="/s/:uuid/send"> with NO target attr (so the body pipeline's _self retarget is exercised).
//   leg C (kanban): real task md files + the kanban scaffold, registered via the /mcp path.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";

const VAULT = join(tmpdir(), "vos231-core-vault");
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, ".void-os"), { recursive: true });
writeFileSync(join(VAULT, "void-os.json"), JSON.stringify({ port: 4317 }));

// leg A — SSE: a session dir with NO body.html yet (hasBody=false → renderShell emits no iframe#f).
const SSE_UUID = "sse-sess-0001";
mkdirSync(join(VAULT, "sessions", SSE_UUID), { recursive: true });
writeFileSync(
  join(VAULT, "sessions", SSE_UUID, "session-meta.json"),
  JSON.stringify({ skill: "deep-research", interactive: false }),
);

// leg B — onboarding: a session whose body.html is a native POST form with NO target attr.
// (No target attr is the key — the body pipeline must retarget it to _self.)
const ONB_UUID = "onb-sess-0002";
const onbDir = join(VAULT, "sessions", ONB_UUID);
mkdirSync(onbDir, { recursive: true });
writeFileSync(
  join(onbDir, "body.html"),
  `<!doctype html><html><body><h1>Welcome — onboarding</h1>` +
  `<form method="POST" action="/s/${ONB_UUID}/send"><input name="display_name" value="Alice">` +
  `<button type="submit">Continue</button></form></body></html>`,
);
writeFileSync(
  join(onbDir, "session-meta.json"),
  JSON.stringify({ skill: "onboarding", interactive: true }),
);

// leg C — kanban: real task md files (one per column) + the kanban scaffold.
const TDIR = join(VAULT, "work", "tasks", "active");
mkdirSync(TDIR, { recursive: true });
const seed = (file: string, id: string, title: string, state: string) =>
  writeFileSync(
    join(TDIR, file),
    `---\nid: ${id}\ntitle: ${title}\nstate: ${state}\n---\n\n## Why\nseed.\n`,
  );
seed("VOS-901-alpha.md", "VOS-901", "Alpha onboarding flow", "todo");
seed("VOS-902-beta.md", "VOS-902", "Beta render seam", "doing");
seed("VOS-903-gamma.md", "VOS-903", "Gamma audit trace", "done");

const db = openRegistry(join(VAULT, ".void-os", "registry.db"));
const app = makeApp(VAULT, db);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });
const baseUrl = `http://127.0.0.1:${server.port}`;

const envOut = process.env.VOS_CORE_ENV_OUT ?? join(tmpdir(), "vos231-core-env.json");
writeFileSync(
  envOut,
  JSON.stringify(
    {
      baseUrl,
      vault: VAULT,
      sseUuid: SSE_UUID,
      sseBodyPath: join(VAULT, "sessions", SSE_UUID, "body.html"),
      onbUuid: ONB_UUID,
      onbBodyPath: join(VAULT, "sessions", ONB_UUID, "body.html"),
      tasksDir: TDIR,
      mcpUrl: `${baseUrl}/mcp`,
      scaffoldPath: join(import.meta.dir, "..", "kit", "scaffolds", "kanban.html"),
    },
    null,
    2,
  ),
);

console.log(`READY ${baseUrl}`);
console.log(`[harness] vault=${VAULT}`);
console.log(`[harness] env sidecar=${envOut}`);
