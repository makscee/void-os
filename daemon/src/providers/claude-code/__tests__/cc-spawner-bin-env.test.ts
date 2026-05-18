// VOS-134: assert createCcSpawner respects VOID_OS_CC_BIN and that explicit
// deps.binary still wins (test seam preserved).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../../adapters/sqlite/migrations";
import { createEventBus } from "../../../events";
import { createPermissionEngine } from "../../../permissions/engine";
import { CC_BIN_ENV_VAR, createCcSpawner } from "../index";

const MIGRATIONS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "adapters",
  "sqlite",
  "migrations",
);

function seedAgent(db: Database): void {
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
}

interface Captured {
  cmd: string[] | null;
}

function makeSpawner(captured: Captured, depsOverrides: { binary?: string } = {}) {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);
  seedAgent(db);
  const tracesDir = join(tmpdir(), `vos-134-traces-${Date.now()}-${Math.random()}`);
  mkdirSync(tracesDir, { recursive: true });
  const bus = createEventBus({ db });
  const engine = createPermissionEngine({
    vaultRoot: "/tmp/vos-134-vault",
    homeRoot: "/tmp/home",
  });
  const cc = createCcSpawner({
    bus,
    db,
    tracesDir,
    binary: depsOverrides.binary,
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
    spawnFn: (cmd, _opts) => {
      captured.cmd = cmd;
      return {
        pid: 99999,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        kill: () => {},
      } as never;
    },
  });
  return { cc };
}

describe("createCcSpawner — VOID_OS_CC_BIN", () => {
  const originalEnv = process.env[CC_BIN_ENV_VAR];
  beforeEach(() => {
    delete process.env[CC_BIN_ENV_VAR];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[CC_BIN_ENV_VAR];
    else process.env[CC_BIN_ENV_VAR] = originalEnv;
  });

  it("uses VOID_OS_CC_BIN as argv[0] when deps.binary is unset", async () => {
    process.env[CC_BIN_ENV_VAR] = "/opt/my-cc/claudev";
    const captured: Captured = { cmd: null };
    const { cc } = makeSpawner(captured);
    await cc.spawn({
      prompt: "hi",
      agent: "journaler",
      cwd: "/tmp/vos-134-vault",
      chatId: "c1",
      taskId: "t1",
      contextId: "c1",
      kind: "chat",
    });
    expect(captured.cmd?.[0]).toBe("/opt/my-cc/claudev");
  });

  it("falls back to 'claudev' when neither deps.binary nor env are set", async () => {
    const captured: Captured = { cmd: null };
    const { cc } = makeSpawner(captured);
    await cc.spawn({
      prompt: "hi",
      agent: "journaler",
      cwd: "/tmp/vos-134-vault",
      chatId: "c1",
      taskId: "t1",
      contextId: "c1",
      kind: "chat",
    });
    expect(captured.cmd?.[0]).toBe("claudev");
  });

  it("explicit deps.binary wins over VOID_OS_CC_BIN (test seam preserved)", async () => {
    process.env[CC_BIN_ENV_VAR] = "/env/should-be-ignored";
    const captured: Captured = { cmd: null };
    const { cc } = makeSpawner(captured, { binary: "/explicit/cc" });
    await cc.spawn({
      prompt: "hi",
      agent: "journaler",
      cwd: "/tmp/vos-134-vault",
      chatId: "c1",
      taskId: "t1",
      contextId: "c1",
      kind: "chat",
    });
    expect(captured.cmd?.[0]).toBe("/explicit/cc");
  });
});
