// session-mcp-config.test.ts — VOS-225 P1 §2: generated session .mcp.json points every
// spawned CC session at the shared daemon-hosted MCP.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionMcpConfig, writeSessionMcpConfig, VAULT_MCP_SERVER_KEY,
} from "../src/session-mcp-config.ts";

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-mcpcfg-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

test("buildSessionMcpConfig wires the void-os-vault http server at the daemon URL", () => {
  const cfg = buildSessionMcpConfig(4317);
  expect(VAULT_MCP_SERVER_KEY).toBe("void-os-vault");
  expect(cfg.mcpServers[VAULT_MCP_SERVER_KEY]).toEqual({
    type: "http",
    url: "http://127.0.0.1:4317/mcp",
  });
});

test("buildSessionMcpConfig respects a custom port", () => {
  expect(buildSessionMcpConfig(9999).mcpServers["void-os-vault"].url).toBe("http://127.0.0.1:9999/mcp");
});

test("buildSessionMcpConfig merges an existing agent mcpServers block (vault server always present)", () => {
  const cfg = buildSessionMcpConfig(4317, { mcpServers: { "agent-tool": { type: "stdio", command: "x" } as any } });
  expect(cfg.mcpServers["agent-tool"]).toBeTruthy();
  expect(cfg.mcpServers["void-os-vault"].type).toBe("http");
});

test("writeSessionMcpConfig writes a parseable .mcp.json + returns the path", () => {
  const p = writeSessionMcpConfig(vault, "exec-abc", 4317);
  expect(existsSync(p)).toBe(true);
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  expect(parsed.mcpServers["void-os-vault"].url).toBe("http://127.0.0.1:4317/mcp");
  // distinct file per session id (no clobber across concurrent spawns)
  expect(p).toContain("exec-abc");
});

test("writeSessionMcpConfig merges an existing agent config file at the given path", () => {
  const agentDir = join(vault, ".void-os", "agent-mcp");
  mkdirSync(agentDir, { recursive: true });
  const agentPath = join(agentDir, "maya.json");
  writeFileSync(agentPath, JSON.stringify({ mcpServers: { "maya-mcp": { type: "stdio", command: "y" } } }));
  const p = writeSessionMcpConfig(vault, "exec-xyz", 4317, agentPath);
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  expect(parsed.mcpServers["maya-mcp"]).toBeTruthy();
  expect(parsed.mcpServers["void-os-vault"]).toBeTruthy();
});
