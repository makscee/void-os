import { test } from "@playwright/test";

test.skip(true, "blocked on VOS-108 — daemon does not yet enforce scoped writes at HTTP boundary; only MCP ask-agent path enforces (daemon/src/adapters/mcp/tools/ask-agent.ts:298)");

test("daemon rejects cross-scope write at HTTP boundary", async () => {
  // placeholder — un-skip when VOS-108 lands
});
