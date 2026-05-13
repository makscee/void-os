import { describe, expect, test } from "bun:test";
import { buildApp, VERSION } from "../src/app.ts";

describe("GET /health", () => {
  test("returns 200 with { ok, version, sessions: 0 }", async () => {
    const app = buildApp();
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
