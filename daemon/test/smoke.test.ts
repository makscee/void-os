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
import {
  ALLOWED_TOOLS,
  ALLOWED_MCP_SERVERS,
} from "../src/providers/claude-code/spawn-settings.ts";

// VOS-111: read the first `{type:"system",subtype:"init",...}` event from a
// stream-json stdout. Used by the subset-assertion test below to inspect
// what CC actually loaded (mcp_servers + tools) under the production
// isolation flags.
async function waitForSystemInit(
  stdout: NodeJS.ReadableStream,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("system.init timeout")), timeoutMs);
    let buf = "";
    stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const j = JSON.parse(line);
          if (j.type === "system" && j.subtype === "init") {
            clearTimeout(t);
            resolve(j);
            return;
          }
        } catch {
          /* not JSON, skip */
        }
      }
    });
    stdout.on("end", () => {
      clearTimeout(t);
      reject(new Error("stdout ended before system.init"));
    });
  });
}

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
// VOS-111: a second opt-in gate that costs less (we kill the child the
// moment we have system.init, no model turn completes). Keeps the
// isolation regression check exercisable without paying the full
// VOS-77 vault.read round-trip.
const smokeIso = process.env.SMOKE === "1" ? test : test.skip;

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

  // VOS-111: regression guard for sub-assertion B of the T0 isolation probe.
  // Spawns claudev with the same isolation flags the production spawner
  // emits (--strict-mcp-config, --setting-sources project, --tools <list>)
  // and reads the first stream-json system.init event. Asserts subset:
  // every mcp_server name CC loaded is in ALLOWED_MCP_SERVERS, every tool
  // it loaded is in ALLOWED_TOOLS. The first guarantees CC didn't merge in
  // operator-personal MCPs from ~/.claude; the second guarantees no
  // disallowed built-in (e.g. AskUserQuestion) leaked through.
  smokeIso(
    "VOS-111: spawned CC sees only ALLOWED_MCP_SERVERS and ALLOWED_TOOLS",
    async () => {
      const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-iso-"));

      const db = new Database(":memory:");
      db.exec(SCHEMA);

      const app = await buildApp({ db, vaultRoot });
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });

      try {
        const mcpJsonPath = path.join(vaultRoot, ".mcp.json");
        fs.writeFileSync(
          mcpJsonPath,
          JSON.stringify({
            mcpServers: {
              "void-os": { type: "http", url: `http://127.0.0.1:${server.port}/mcp` },
            },
          }),
        );

        const claudev = "/Users/admin/hub/workspace/claudev/claudev.sh";
        // Keep prompt minimal — costs real tokens on the operator pool. We
        // only need system.init, not a useful answer.
        const prompt = "Reply with the single word: ok";
        const child = spawn(
          claudev,
          [
            "-p", prompt,
            "--output-format", "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--setting-sources", "project",
            "--tools", ALLOWED_TOOLS.join(","),
            "--mcp-config", mcpJsonPath,
          ],
          {
            env: { ...process.env, PATH: process.env.PATH },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let sys: Record<string, unknown>;
        try {
          sys = await waitForSystemInit(child.stdout!);
        } finally {
          // We have system.init — no need to wait for the model to finish.
          child.kill("SIGKILL");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawServers = (sys.mcp_servers ?? []) as any[];
        const mcpServers: string[] = rawServers.map((s) =>
          typeof s === "string" ? s : (s?.name ?? String(s)),
        );
        const tools: string[] = (sys.tools ?? []) as string[];

        // Verbose: dump observed values so a failing CI run is debuggable
        // without having to re-spawn claudev locally.
        // eslint-disable-next-line no-console
        console.log("[VOS-111 smoke] mcp_servers =", JSON.stringify(mcpServers));
        // eslint-disable-next-line no-console
        console.log("[VOS-111 smoke] tools =", JSON.stringify(tools));

        expect(mcpServers.length).toBeGreaterThan(0);
        for (const s of mcpServers) {
          expect(ALLOWED_MCP_SERVERS).toContain(s);
        }
        expect(tools.length).toBeGreaterThan(0);
        for (const t of tools) {
          expect(ALLOWED_TOOLS).toContain(t);
        }
      } finally {
        server.stop(true);
        fs.rmSync(vaultRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
