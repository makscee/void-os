import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { buildApp, VERSION } from "../src/app.ts";

const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

describe("GET /health", () => {
  test("returns 200 with { ok, version, vault_root, uptime_s, sessions: 0 }", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = await buildApp({ db, vaultRoot });
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Authorization: "Bearer test-token" },
      }),
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBe(VERSION);
    expect(body.vault_root).toBe(vaultRoot);
    expect(typeof body.uptime_s).toBe("number");
    expect(Number.isInteger(body.uptime_s)).toBe(true);
    expect(body.sessions).toBe(0);
  });
});
