// mcp-transport.test.ts — VOS-225 §2: the daemon /mcp endpoint speaks streamable-HTTP MCP.
// Drives the route via app.fetch with raw JSON-RPC (the same protocol a real CC client uses):
// initialize → tools/list → tools/call vault.write. Asserts WIRING (tools present, file written,
// audit emitted), not LLM timing.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { auditPath } from "../src/audit.ts";

let vault: string;
const db = openRegistry(":memory:");
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-mcptx-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

const MCP_HEADERS = {
  "content-type": "application/json",
  // streamable-HTTP requires the client to accept BOTH json and the SSE stream.
  "accept": "application/json, text/event-stream",
};

async function rpc(app: ReturnType<typeof makeApp>, body: unknown) {
  const res = await app.request("/mcp", { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}

test("/mcp initialize + tools/list exposes the four vault tools", async () => {
  const app = makeApp(vault, db);
  const init = await rpc(app, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  expect(init.status).toBe(200);
  expect(init.text).toContain("void-os-vault"); // server name in the initialize result

  const list = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  expect(list.status).toBe(200);
  for (const t of ["vault.write", "vault.append", "page.register", "page.list"]) {
    expect(list.text).toContain(t);
  }
});

test("/mcp tools/call vault.write writes the file + emits an audit line (real path through HTTP)", async () => {
  const app = makeApp(vault, db);
  // initialize first (stateless transport still expects the lifecycle)
  await rpc(app, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  const call = await rpc(app, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "vault.write", arguments: { path: "via-mcp.md", content: "hello-from-mcp", exec_id: "exec-proof" } },
  });
  expect(call.status).toBe(200);
  expect(call.text).toContain("wrote via-mcp.md");
  // file landed on disk
  expect(readFileSync(join(vault, "via-mcp.md"), "utf8")).toBe("hello-from-mcp");
  // audit line emitted with the self-reported exec id
  const audit = readFileSync(auditPath(vault), "utf8").trim();
  expect(audit).toContain('"tool":"vault.write"');
  expect(audit).toContain('"exec":"exec-proof"');
  expect(audit).toContain('"source":"mcp"');
});
