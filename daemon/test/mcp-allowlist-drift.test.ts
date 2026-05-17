// VOS-111: forward-drift guard. Asserts every MCP tool the void-os MCP
// server registers is also exposed to spawned agents via ALLOWED_TOOLS.
// If you add a new MCP tool and this test fails: add the corresponding
// `mcp__void-os__<tool>` entry to ALLOWED_TOOLS in spawn-settings.ts.

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TOOLS,
  mcpToolNameFor,
} from "../src/providers/claude-code/spawn-settings";
import { buildMcpServer } from "../src/adapters/mcp";

describe("VOS-111: MCP tool allowlist drift guard", () => {
  test("every registered void-os MCP tool is in ALLOWED_TOOLS", () => {
    const mcp = buildMcpServer({
      db: {} as never,
      vaultRoot: "/tmp",
      engine: {} as never,
      bridge: {} as never,
      bus: { emit: () => {} } as never,
      loadAgentDefn: () => ({ name: "test" }) as never,
      dispatchChildTask: async () => {},
      callingAgent: { name: "test" } as never,
    });
    // _registeredTools is a private SDK field on McpServer — a plain
    // object keyed by tool name (see
    // node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js,
    // `this._registeredTools = {}` + `this._registeredTools[name] = ...`).
    // No public enumeration API exists as of the SDK version pinned in
    // package.json; reading the field directly is the least-bad option.
    // If a future SDK removes or renames it, fall back to hardcoding the
    // current three tools (vault.read, ask_user, ask_agent) with a
    // comment pointing back to this guard.
    const registry = (mcp as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const registered: string[] = Object.keys(registry ?? {});
    expect(registered.length).toBeGreaterThan(0);
    for (const tool of registered) {
      const exposed = mcpToolNameFor("void-os", tool);
      expect(ALLOWED_TOOLS).toContain(exposed);
    }
  });
});
