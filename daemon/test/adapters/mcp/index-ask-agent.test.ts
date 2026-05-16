// VOS-89 T10 (rewritten under VOS-97): tool registration in the MCP server.
//
// Pre-VOS-97 this test imported `listMcpTools()` and asserted the JSON Schema
// shape of `ask_agent`. After VOS-97 every tool is registered via
// `McpServer.registerTool` with a Zod raw shape; the JSON Schema literal is
// produced by the SDK lazily, not by us. The corresponding contract surface
// is now `askAgentDef` / `vaultReadDef` / `askUserDef` (Zod-shaped) plus the
// fact that `buildMcpServer` constructs a Server with all three registered.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "../../../src/events/index.ts";
import { buildMcpServer } from "../../../src/adapters/mcp/index.ts";
import { askAgentDef } from "../../../src/adapters/mcp/tools/ask-agent.ts";
import { askUserDef } from "../../../src/adapters/mcp/tools/ask-user.ts";
import { vaultReadDef } from "../../../src/adapters/mcp/tools/vault-read.ts";

describe("MCP tool registration (VOS-97)", () => {
  test("ask_agent Zod input shape carries spec'd fields", () => {
    const shape = askAgentDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(shape.target_agent_id?._def).toBeDefined();
    expect(shape.message?._def).toBeDefined();
    expect(shape.system_message?._def).toBeDefined();
  });

  test("ask_user + vault.read also expose Zod input shapes", () => {
    const askUserShape = askUserDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(askUserShape.question?._def).toBeDefined();
    const vaultReadShape = vaultReadDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(vaultReadShape.path?._def).toBeDefined();
  });

  test("buildMcpServer constructs a Server (smoke)", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
    const db = new Database(":memory:");
    const bus = createEventBus();
    const server = buildMcpServer({ vaultRoot, db, bus });
    expect(server).toBeDefined();
    // The low-level Server exposes setRequestHandler/close; smoke-check one.
    expect(typeof (server as { close?: unknown }).close).toBe("function");
  });
});
