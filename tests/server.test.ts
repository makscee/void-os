/**
 * T11: Server route integration test.
 * spawnTurn is stubbed via mock.module so no real `vc` process is spawned.
 * Tests: GET /, GET /s/:uuid, GET /s/:uuid/body (with + without error.txt), POST /s/:uuid/send.
 */
import { expect, test, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { bodyPath, sessionDir, errorPath } from "../src/paths.ts";

const vault = "/tmp/voidos-server-test";

// Stub spawnTurn before importing server.ts so routes don't fire real vc processes.
// Bun.mock.module replaces the module for all subsequent imports in this file.
const spawnCalls: Array<{ vault: string; uuid: string; argv: string[] }> = [];
mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => [
    "--", "--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`,
    "--permission-mode", "bypassPermissions",
  ],
  buildAnswerArgv: (uuid: string, text: string) => [
    "--", "--resume", uuid, "-p", `[render contract: rewrite body.html, no terminal reply]\n${text}`,
    "--permission-mode", "bypassPermissions",
  ],
  spawnTurn: (v: string, u: string, a: string[]) => { spawnCalls.push({ vault: v, uuid: u, argv: a }); },
}));

// Import AFTER mock is registered
const { makeApp } = await import("../src/server.ts");

beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(`${vault}/sessions`, { recursive: true });
});

test("GET / renders dashboard with void-os title", async () => {
  const app = makeApp(vault);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("void-os");
});

test("GET /s/:uuid/body serves body.html content", async () => {
  mkdirSync(sessionDir(vault, "u9"), { recursive: true });
  writeFileSync(bodyPath(vault, "u9"), "<title>u9</title>BODY_CONTENT");
  const app = makeApp(vault);
  const html = await (await app.request("/s/u9/body")).text();
  expect(html).toContain("BODY_CONTENT");
});

test("GET /s/:uuid/body appends error marker when error.txt present (non-timeout error)", async () => {
  mkdirSync(sessionDir(vault, "u-err"), { recursive: true });
  // error.txt written AFTER body.html, non-timeout content — banner must show
  writeFileSync(bodyPath(vault, "u-err"), "<title>err</title>BODY");
  const past = new Date(Date.now() - 5000);
  utimesSync(bodyPath(vault, "u-err"), past, past);
  writeFileSync(errorPath(vault, "u-err"), "exit 1 boom");
  const app = makeApp(vault);
  const html = await (await app.request("/s/u-err/body")).text();
  expect(html).toContain("BODY");
  expect(html).toContain("boom");
});

test("GET /s/:uuid/body suppresses timeout error when body.html is newer than error.txt", async () => {
  const id = "u-timeout-suppressed";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  // error.txt written first (simulating watchdog), body.html written later (post-SIGTERM)
  writeFileSync(errorPath(vault, id), "timeout after 300s — vc process killed");
  const past = new Date(Date.now() - 3000);
  utimesSync(errorPath(vault, id), past, past);
  writeFileSync(bodyPath(vault, id), "<title>ok</title>FORM_CONTENT");
  const app = makeApp(vault);
  const html = await (await app.request(`/s/${id}/body`)).text();
  expect(html).toContain("FORM_CONTENT");
  // timeout banner must NOT appear
  expect(html).not.toContain("timeout");
});

test("GET /s/:uuid/body shows timeout error when body.html NOT updated after kill", async () => {
  const id = "u-timeout-noadvance";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  // body.html written first (placeholder), error.txt written later (watchdog fires)
  writeFileSync(bodyPath(vault, id), "<title>wait</title>session starting...");
  const past = new Date(Date.now() - 3000);
  utimesSync(bodyPath(vault, id), past, past);
  writeFileSync(errorPath(vault, id), "timeout after 300s — vc process killed");
  const app = makeApp(vault);
  const html = await (await app.request(`/s/${id}/body`)).text();
  expect(html).toContain("session starting");
  // timeout banner MUST appear — skill never produced output
  expect(html).toContain("timeout");
});

test("GET /s/:uuid/body returns 404 when no body.html", async () => {
  const app = makeApp(vault);
  const res = await app.request("/s/no-such-uuid/body");
  expect(res.status).toBe(404);
});

test("GET /s/:uuid returns the iframe shell with correct src and vault-anchored resume cmd", async () => {
  const html = await (await makeApp(vault).request("/s/u9")).text();
  expect(html).toContain('src="/s/u9/body"');
  expect(html).toContain("/s/u9/stream");
  // Resume command must include the vault path so the user runs it from the right cwd
  expect(html).toContain(vault);
  expect(html).toContain("--resume");
  expect(html).toContain("u9");
});

test("POST /s/:uuid/send calls stubbed spawnTurn and returns working page", async () => {
  mkdirSync(sessionDir(vault, "send-uuid"), { recursive: true });
  writeFileSync(bodyPath(vault, "send-uuid"), "<title>s</title>hi");
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("text", "my answer");
  const res = await app.request("/s/send-uuid/send", { method: "POST", body: form });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("received");
  expect(spawnCalls.length).toBe(before + 1);
  expect(spawnCalls[spawnCalls.length - 1].uuid).toBe("send-uuid");
});

test("POST /launch writes placeholder, calls spawnTurn, redirects to /s/:uuid", async () => {
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("skill", "deep-research");
  form.append("text", "AI safety");
  const res = await app.request("/launch", { method: "POST", body: form });
  // redirect to /s/<uuid>
  expect(res.status).toBe(302);
  const loc = res.headers.get("location") ?? "";
  expect(loc).toMatch(/^\/s\/[0-9a-f-]{36}$/);
  expect(spawnCalls.length).toBe(before + 1);
  const lastArgv = spawnCalls[spawnCalls.length - 1].argv;
  // prompt is in the -p slot: "/deep-research AI safety"
  expect(lastArgv.some((a) => a.includes("deep-research"))).toBe(true);
});
