#!/usr/bin/env bun
// vos-proof-vos225.ts — VOS-225 P1 real-path proof.
//
// Proves the FULL wiring a spawned CC session traverses, end to end, against a LIVE daemon:
//   1. boot the real daemon (makeApp + Bun.serve) on a real port
//   2. generate a session .mcp.json via the SAME writeSessionMcpConfig the spawn path calls
//   3. read the daemon-MCP URL OUT of that generated config (no hardcoding — proves the wiring)
//   4. connect the real MCP SDK Client over streamable-HTTP to that URL
//   5. tools/list → assert the four v1 tools are present
//   6. tools/call vault.write → assert the file landed on disk + an audit line was emitted (mcp)
//   7. tools/call page.register → assert the manifest upserted + GET /p/:slug serves it live
//
// This is the faithful real-path: identical transport + identical generated config + identical
// tool dispatch a CC session uses. The LLM driver is replaced by a deterministic SDK client so
// the proof asserts WIRING, not model timing (per void-os proof-script rules). The full live-CC
// E2E (a real `vc` session calling the tool) is master-run (reaper SIGKILLs subagent process
// trees at ~2-4min) and captured separately in MASTER-PROOF.md.
//
// Hard-fails (exit 1) on every load-bearing assertion — no WARN-and-continue.
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { writeSessionMcpConfig } from "../src/session-mcp-config.ts";
import { auditPath } from "../src/audit.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function pass(msg: string) { console.log(`PASS: ${msg}`); }

const PORT = 4391; // unlikely to collide with a running daemon
const vault = mkdtempSync(join(tmpdir(), "vos-225-proof-"));
const db = openRegistry(":memory:");
const app = makeApp(vault, db);
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 60 });
console.log(`[proof] daemon live at http://127.0.0.1:${PORT}, vault=${vault}`);

try {
  // ── step 2-3: generate the session config the spawn path generates, read the URL from it ──
  const runId = "exec-proof-225";
  const cfgPath = writeSessionMcpConfig(vault, runId, PORT, null);
  if (!existsSync(cfgPath)) fail(`session .mcp.json not generated at ${cfgPath}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const entry = cfg.mcpServers?.["void-os-vault"];
  if (!entry || entry.type !== "http" || !entry.url) fail(`generated config missing void-os-vault http entry: ${JSON.stringify(cfg)}`);
  pass(`session .mcp.json generated, void-os-vault → ${entry.url}`);

  // ── step 4: connect the REAL MCP SDK client to the URL FROM THE GENERATED CONFIG ──
  const client = new Client({ name: "vos225-proof", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(entry.url));
  await client.connect(transport);
  pass(`real MCP client connected over streamable-HTTP to the generated URL`);

  // ── step 5: tools/list — the four v1 tools must be present ──
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const want = ["page.list", "page.register", "vault.append", "vault.write"];
  for (const t of want) if (!tools.includes(t)) fail(`tool missing from /mcp tools/list: ${t} (got ${tools.join(",")})`);
  if (tools.length !== want.length) fail(`unexpected extra tools (v1 must expose exactly 4): ${tools.join(",")}`);
  pass(`tools/list exposes exactly the four v1 tools: ${tools.join(", ")}`);

  // ── step 6: vault.write via the client → file + audit ──
  const writeRes: any = await client.callTool({
    name: "vault.write",
    arguments: { path: "proof/written-by-mcp.md", content: "via-real-mcp-client", exec_id: runId },
  });
  if (writeRes.isError) fail(`vault.write returned isError: ${JSON.stringify(writeRes.content)}`);
  const onDisk = join(vault, "proof/written-by-mcp.md");
  if (!existsSync(onDisk)) fail(`vault.write did NOT write the file at ${onDisk}`);
  if (readFileSync(onDisk, "utf8") !== "via-real-mcp-client") fail(`file content mismatch`);
  const auditRaw = existsSync(auditPath(vault)) ? readFileSync(auditPath(vault), "utf8") : "";
  if (!auditRaw.includes('"tool":"vault.write"') || !auditRaw.includes(`"exec":"${runId}"`) || !auditRaw.includes('"source":"mcp"')) {
    fail(`audit line not emitted for vault.write (source:mcp, exec:${runId}). audit=${auditRaw || "<empty>"}`);
  }
  pass(`vault.write wrote ${onDisk} + emitted audit (source:mcp, exec:${runId})`);

  // ── step 7: page.register via the client → manifest + GET /p/:slug serves the panel live ──
  // write the panel html first via vault.write (the same tool an agent would use), then register.
  await client.callTool({ name: "vault.write", arguments: {
    path: "panels/proofboard.html",
    content: `<div data-vos-source="work/tasks/active/*.md">PROOFBOARD slug={{VOS_SLUG}}</div>`,
    exec_id: runId } });
  const regRes: any = await client.callTool({
    name: "page.register",
    arguments: { slug: "proofboard", title: "Proof Board", path: "panels/proofboard.html", exec_id: runId },
  });
  if (regRes.isError) fail(`page.register returned isError: ${JSON.stringify(regRes.content)}`);
  const listRes: any = await client.callTool({ name: "page.list", arguments: {} });
  const pages = JSON.parse(listRes.content[0].text);
  if (!pages.find((p: any) => p.slug === "proofboard" && p.pinned === true)) fail(`page.list missing pinned proofboard: ${listRes.content[0].text}`);
  // the live page actually serves through the daemon HTTP route, with {{VOS_SLUG}} substituted
  const bodyRes = await fetch(`http://127.0.0.1:${PORT}/p/proofboard/body`);
  if (bodyRes.status !== 200) fail(`GET /p/proofboard/body status ${bodyRes.status}`);
  const bodyHtml = await bodyRes.text();
  if (!bodyHtml.includes("PROOFBOARD slug=proofboard")) fail(`/p/proofboard/body did not render the panel with substituted slug: ${bodyHtml.slice(0, 200)}`);
  if (!bodyHtml.includes("/assets/htmx.min.js")) fail(`/p/proofboard/body missing vendored htmx injection`);
  pass(`page.register → manifest upserted (pinned) + GET /p/proofboard/body serves it live with htmx + {{VOS_SLUG}}`);

  await client.close();
  console.log("\nALL PASS — VOS-225 P1 real-path wiring verified (daemon-hosted MCP via generated .mcp.json, live pages).");
} finally {
  server.stop(true);
}
