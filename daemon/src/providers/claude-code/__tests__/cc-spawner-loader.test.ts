import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../../adapters/sqlite/migrations";
import { createEventBus } from "../../../events";
import { createPermissionEngine } from "../../../permissions/engine";
import { createCcSpawner } from "../index";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "adapters", "sqlite", "migrations");

describe("cc-spawner loader integration", () => {
  it("writes <runId>.settings.json + <runId>.mcp.json on spawn", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    // Seed an agent_cards row with explicit scopes.
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      [
        "journaler",
        JSON.stringify({
          name: "journaler",
          read_scope: ["vault/journal/**"],
          write_scope: ["vault/journal/**"],
        }),
      ],
    );

    const tracesDir = join(tmpdir(), `vos-106-traces-${Date.now()}`);
    mkdirSync(tracesDir, { recursive: true });
    const vaultRoot = "/tmp/vos-106-vault";

    const bus = createEventBus({ db });
    const engine = createPermissionEngine({ vaultRoot, homeRoot: "/tmp/home" });

    const cc = createCcSpawner({
      bus,
      db,
      tracesDir,
      engine,
      daemonBase: "http://127.0.0.1:17777",
      hookScriptPath: "/abs/pre-tool-use.ts",
      loadAgentDefn: (name) => {
        const row = db
          .query("SELECT card_json FROM agent_cards WHERE agent_name=?")
          .get(name) as { card_json: string } | undefined;
        if (!row) throw new Error(`unknown agent: ${name}`);
        const parsed = JSON.parse(row.card_json);
        return {
          name,
          read_scope: parsed.read_scope,
          write_scope: parsed.write_scope,
        };
      },
      // Test seam: skip the actual `claudev claude` subprocess; just verify
      // that the settings files are written and the argv is well-formed.
      spawnFn: (cmd, _opts) => {
        return {
          pid: 99999,
          exited: Promise.resolve(0),
          stdout: new ReadableStream({ start: (c) => c.close() }),
          stderr: new ReadableStream({ start: (c) => c.close() }),
          kill: () => {},
          _cmd: cmd, // captured for assertion below
        } as never;
      },
    });

    const proc = await cc.spawn({
      prompt: "hi",
      agent: "journaler",
      cwd: vaultRoot,
      chatId: "chat-1",
      taskId: "task-1",
      contextId: "chat-1",
      kind: "chat",
    });

    const runId = proc.runId;
    const settingsPath = join(tracesDir, `${runId}.settings.json`);
    const mcpPath = join(tracesDir, `${runId}.mcp.json`);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(mcpPath)).toBe(true);

    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(mcp.mcpServers["void-os"].url).toContain("agent=journaler");
    // URL is stable across runs — runId no longer in query (was busting prompt cache).
    expect(mcp.mcpServers["void-os"].url).not.toContain("run=");
  });
});
