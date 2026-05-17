/**
 * VOS-108: assert daemon rejects an out-of-scope vault.create at the
 * MCP-over-HTTP boundary. Drives the MCP client directly from the spec —
 * the UI surface for vault writes is covered separately by VOS-109.
 *
 * "HTTP boundary" in the VOS-107 stub language refers to the daemon's
 * /mcp Streamable-HTTP transport; MCP-over-HTTP IS HTTP.
 *
 * The shared e2e daemon (plugin/e2e/globalSetup.ts) seeds the `maya`
 * agent_card with `read_scope:["vault/**"], write_scope:[]` — the empty
 * write_scope makes the scope gate deny every vault.* write, so any
 * vault.create by `?agent=maya` must reject with SCOPE_DENIED.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface E2EState {
  port: number;
}

function readE2EState(): E2EState {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  return JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
}

test("daemon rejects cross-scope write at MCP-over-HTTP boundary", async () => {
  const state = readE2EState();
  const base = `http://127.0.0.1:${state.port}`;

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=maya`));
  const client = new Client({ name: "vos-108-e2e", version: "0" });
  await client.connect(transport);

  try {
    const res = await client.callTool({
      name: "vault.create",
      arguments: { path: "journal/forbidden.md", content: "denied" },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/^SCOPE_DENIED:/);
  } finally {
    await client.close();
  }
});
