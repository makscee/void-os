/**
 * VOS-77 claudev → claude → MCP → daemon smoke test.
 *
 * Gated on ANTHROPIC_API_KEY / CLAUDEV_POOL_TOKEN. When unset, test.skip
 * keeps CI green. When set, spawns the real claudev binary against an
 * in-memory daemon and asserts an `mcp.vault.read` event row is recorded.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/app.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

const HAS_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDEV_POOL_TOKEN);
const smoke = HAS_KEY ? test : test.skip;

describe("VOS-77 smoke: claudev → claude → MCP → daemon", () => {
  smoke("vault.read tool call is recorded in events table", async () => {
    // 1. Seed vault with a per-run marker.
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-smoke-"));
    const marker = randomUUID();
    fs.mkdirSync(path.join(vaultRoot, "notes"));
    fs.writeFileSync(path.join(vaultRoot, "notes", "hello.md"), `smoke ${marker}\n`);

    const db = new Database(":memory:");
    db.exec(SCHEMA);

    // 2. Start daemon on ephemeral port.
    const app = await buildApp({ db, vaultRoot });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });

    try {
      // 3. Write tmp .mcp.json.
      const mcpJsonPath = path.join(vaultRoot, ".mcp.json");
      fs.writeFileSync(
        mcpJsonPath,
        JSON.stringify({
          mcpServers: {
            "void-os": { type: "http", url: `http://127.0.0.1:${server.port}/mcp` },
          },
        }),
      );

      // 4. Spawn claudev.
      const claudev = "/Users/admin/hub/workspace/claudev/claudev.sh";
      const prompt =
        "Use the void-os vault.read tool to read notes/hello.md and tell me what it says.";
      const child = spawn(claudev, ["--mcp-config", mcpJsonPath, "-p", prompt], {
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claudev timeout")); }, 60_000);
        child.on("close", (code) => { clearTimeout(t); resolve(code ?? -1); });
      });
      expect(exitCode).toBe(0);

      // 5. Assert the daemon recorded a vault.read call.
      const row = db.prepare(
        `SELECT type, data FROM events WHERE type='mcp.vault.read' ORDER BY ts DESC LIMIT 1`,
      ).get() as { type: string; data: string } | undefined;
      expect(row).toBeDefined();
      const data = JSON.parse(row!.data);
      expect(data.ok).toBe(true);
      expect(data.input.path).toBe("notes/hello.md");
    } finally {
      server.stop(true);
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
