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
  test("returns 200 with { ok, version, sessions: 0 }", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = buildApp({ db, vaultRoot });
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      version: VERSION,
      sessions: 0,
    });
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});
