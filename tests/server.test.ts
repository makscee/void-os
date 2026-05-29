/**
 * T11: Server route integration test.
 * spawnTurn is stubbed via mock.module so no real `vc` process is spawned.
 * Tests: GET /, GET /s/:uuid, GET /s/:uuid/body (with + without error.txt), POST /s/:uuid/send.
 */
import { expect, test, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { bodyPath, sessionDir, errorPath } from "../src/paths.ts";
import { join } from "node:path";

const vault = "/tmp/voidos-server-test";

// Stub spawnTurn before importing server.ts so routes don't fire real vc processes.
// Bun.mock.module replaces the module for all subsequent imports in this file.
const spawnCalls: Array<{ vault: string; uuid: string; argv: string[]; command: string }> = [];
mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => [
    "--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`,
    "--permission-mode", "bypassPermissions",
  ],
  buildAnswerArgv: (uuid: string, text: string) => [
    "--resume", uuid, "-p", `[render contract: rewrite body.html, no terminal reply]\n${text}`,
    "--permission-mode", "bypassPermissions",
  ],
  tokenizeCommand: (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean),
  spawnTurn: (v: string, u: string, a: string[], cmd: string) => { spawnCalls.push({ vault: v, uuid: u, argv: a, command: cmd }); },
}));

// Stub preflight to return authed by default (tests override per-test via module reload if needed)
mock.module("../src/preflight.ts", () => ({
  realDeps: {
    vcStatus: async () => ({ ok: true, msg: "authed" }),
  },
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

test("POST /s/:uuid/send serializes ALL form fields (Bug #1 fix)", async () => {
  mkdirSync(sessionDir(vault, "multi-uuid"), { recursive: true });
  writeFileSync(bodyPath(vault, "multi-uuid"), "<title>s</title>hi");
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("name", "Alice");
  form.append("skill_deep-research", "on");
  const res = await app.request("/s/multi-uuid/send", { method: "POST", body: form });
  expect(res.status).toBe(200);
  const html = await res.text();
  // Working page must echo submitted fields (Bug #5 fix)
  expect(html).toContain("Alice");
  expect(html).toContain("skill_deep-research");
  expect(html).toContain("elapsed");
  // Spawned argv must include ALL fields
  expect(spawnCalls.length).toBe(before + 1);
  const lastArgv = spawnCalls[spawnCalls.length - 1].argv;
  const promptArg = lastArgv.find((a) => a.includes("name:"));
  expect(promptArg).toBeDefined();
  expect(promptArg).toContain("Alice");
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

/**
 * SSE keepalive regression test (VOS-181):
 * The /stream route must emit a ": ping" SSE comment within PING_INTERVAL_MS (5s)
 * even when body.html does NOT change — this keeps the connection alive during cold starts
 * and prevents Bun's idleTimeout from killing the socket.
 *
 * We collect SSE chunks from the stream with a timeout and assert that a ping
 * comment arrives within the expected window.
 */
test("GET /s/:uuid/stream emits SSE keepalive ping within 6s when body.html does not change", async () => {
  const id = "stream-keepalive-test";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  // Write body.html but DO NOT advance its mtime — mtime stays fixed so no "reload" fires
  const bp = bodyPath(vault, id);
  writeFileSync(bp, "<title>k</title>waiting");
  // Backdate so stat mtime < now
  const past = new Date(Date.now() - 10_000);
  utimesSync(bp, past, past);

  const app = makeApp(vault);
  const res = await app.request(`/s/${id}/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  // Collect up to 6 seconds of SSE chunks and assert a ": ping" comment arrives
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];
  const deadline = Date.now() + 6_000;

  outer: while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true as const }), deadline - Date.now()),
      ),
    ]);
    if (done) break;
    if (value) {
      const chunk = decoder.decode(value);
      collected.push(chunk);
      // Stop as soon as we see a ping
      if (collected.join("").includes(": ping")) break outer;
    }
  }
  reader.cancel();

  const fullText = collected.join("");
  expect(fullText).toContain(": ping");
}, 10_000); // 10s test timeout — ping fires at 5s so this is safe

// Bug 2: /s/:uuid shell should show session skill name in header, not raw uuid
test("GET /s/:uuid shows skill name in header when session-meta.json exists", async () => {
  const id = "u-named-session";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<title>s</title>body");
  writeFileSync(
    join(sessionDir(vault, id), "session-meta.json"),
    JSON.stringify({ skill: "smoke-test", launchedAt: Date.now(), text: "", runner: "vc --" }),
  );
  const html = await (await makeApp(vault).request(`/s/${id}`)).text();
  expect(html).toContain("smoke-test");
  // raw id must NOT appear in the session-name slot
  expect(html).not.toMatch(/class="session-name"[^>]*>u-named-session</);
});

// Bug 1: /s/:uuid/body should wrap bare HTML fragments in a light-themed document
test("GET /s/:uuid/body wraps bare fragment with readable light-theme CSS", async () => {
  const id = "u-bare-body";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  // smoke-test writes bare fragments: no <html>, no <style>
  writeFileSync(bodyPath(vault, id), "<h1>smoke-test ✓ session live</h1><p>no input</p>");
  const html = await (await makeApp(vault).request(`/s/${id}/body`)).text();
  // Must include explicit color + background so text is readable on any system
  expect(html).toContain("color");
  expect(html).toContain("background");
  expect(html).toContain("smoke-test ✓ session live");
});

test("GET /s/:uuid/body does NOT double-wrap full HTML documents", async () => {
  const id = "u-full-html-body";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<!doctype html><html><head><title>t</title></head><body>full</body></html>");
  const html = await (await makeApp(vault).request(`/s/${id}/body`)).text();
  // Should pass through as-is (single doctype)
  expect(html.split("<!doctype html").length).toBe(2);
  expect(html).toContain("full");
});

test("POST /launch writes placeholder + session-meta.json, calls spawnTurn, redirects", async () => {
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
  // session-meta.json must be written with skill name
  const uuid = loc.replace("/s/", "");
  const meta = JSON.parse(readFileSync(join(sessionDir(vault, uuid), "session-meta.json"), "utf8"));
  expect(meta.skill).toBe("deep-research");
  expect(meta.text).toBe("AI safety");
});

test("POST /launch persists resolved runner command in session-meta", async () => {
  // Write a vault config with a custom runner
  writeFileSync(
    join(vault, "void-os.json"),
    JSON.stringify({
      vault, onboarded: true, skills: [], answers: {}, port: 4317,
      runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }],
      defaultRunner: "vc (relay)",
    }),
  );
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("skill", "smoke-test");
  form.append("text", "");
  form.append("runner", "artem");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  const uuid = res.headers.get("location")!.split("/s/")[1];
  const meta = JSON.parse(readFileSync(join(sessionDir(vault, uuid), "session-meta.json"), "utf8"));
  expect(meta.runner).toBe("claude_artem");
  expect(spawnCalls[spawnCalls.length - 1].command).toBe("claude_artem");
});

test("POST /s/:uuid/send reuses runner from session-meta on resume", async () => {
  const id = "resume-runner-uuid";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<title>r</title>hi");
  // Pre-seed session-meta with a non-default runner
  writeFileSync(
    join(sessionDir(vault, id), "session-meta.json"),
    JSON.stringify({ skill: "smoke-test", launchedAt: Date.now(), text: "", runner: "claude_artem" }),
  );
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("text", "echo: hello");
  const res = await app.request(`/s/${id}/send`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  expect(spawnCalls[spawnCalls.length - 1].command).toBe("claude_artem");
});

test("GET /s/:uuid/transcript renders escaped turns from the CC transcript", async () => {
  const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  // Inject directly: seed the real ~/.claude/projects subdir that locateTranscript scans.
  const proj = join(process.env.HOME!, ".claude", "projects", "-voidos-server-test");
  mkdirSync(proj, { recursive: true });
  const txFile = join(proj, `${uuid}.jsonl`);
  writeFileSync(
    txFile,
    `{"type":"user","message":{"role":"user","content":"/smoke-test go"}}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working <x>"}]}}\n`,
  );
  try {
    const app = makeApp(vault);
    const res = await app.request(`/s/${uuid}/transcript`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/smoke-test go");
    expect(body).toContain("working &lt;x&gt;");
  } finally {
    // Clean up the injected fixture
    try { rmSync(txFile); } catch { /* ignore */ }
  }
});

test("GET /s/:uuid/transcript returns strictly empty body for unknown uuid", async () => {
  const app = makeApp(vault);
  const res = await app.request("/s/99999999-8888-7777-6666-555555555555/transcript");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
});
