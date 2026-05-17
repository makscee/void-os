import { test, expect } from "bun:test";
import { Hono } from "hono";
import { makeRequireAuth } from "../src/auth/middleware.ts";

function buildAuthApp(token: string) {
  const app = new Hono();
  app.use("/secured/*", makeRequireAuth(token));
  app.get("/secured/ping", (c) => c.json({ ok: true }));
  app.get("/open/ping", (c) => c.json({ ok: true }));
  return app;
}

test("Authorization Bearer matches token → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping", {
    headers: { Authorization: "Bearer good" },
  });
  expect(res.status).toBe(200);
});

test("?token= query matches token → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good");
  expect(res.status).toBe(200);
});

test("missing token → 401", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping");
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("E_UNAUTHORIZED");
});

test("wrong token → 401", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping", {
    headers: { Authorization: "Bearer wrong" },
  });
  expect(res.status).toBe(401);
});

test("Origin header from browser is rejected → 403", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good", {
    headers: { Origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("E_BAD_ORIGIN");
});

test("no Origin header (CLI) is allowed → 200", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/secured/ping?token=good");
  expect(res.status).toBe(200);
});

test("unsecured route remains open without token", async () => {
  const app = buildAuthApp("good");
  const res = await app.request("/open/ping");
  expect(res.status).toBe(200);
});
