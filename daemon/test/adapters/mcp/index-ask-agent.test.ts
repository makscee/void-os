// VOS-89 T10: schema registration for ask_agent in the MCP tools list.
//
// The plan (lines 1064–1079) specifies a `listMcpTools()` helper export
// from src/adapters/mcp/index.ts that returns the static tool schemas.
// This test asserts the ask_agent tool is registered with the spec'd
// required-fields and properties shape.

import { describe, test, expect } from "bun:test";
import { listMcpTools } from "../../../src/adapters/mcp/index.ts";

describe("MCP tools list", () => {
  test("includes ask_agent with correct schema", () => {
    const tools = listMcpTools();
    const t = tools.find((x) => x.name === "ask_agent");
    expect(t).toBeDefined();
    const schema = t!.inputSchema as {
      required: string[];
      properties: Record<string, { type: string } | undefined>;
    };
    expect(schema.required).toEqual(["target_agent_id", "message"]);
    expect(schema.properties.target_agent_id?.type).toBe("string");
    expect(schema.properties.message?.type).toBe("string");
    expect(schema.properties.system_message?.type).toBe("string");
  });

  test("still lists ask_user and vault.read", () => {
    const tools = listMcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ask_user");
    expect(names).toContain("vault.read");
  });
});
