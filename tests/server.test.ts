/**
 * T11: Server route integration test.
 * spawnTurn is stubbed via mock.module so no real `vc` process is spawned.
 * Tests: GET /, GET /s/:uuid, GET /s/:uuid/body (with + without error.txt), POST /s/:uuid/send.
 */
import { expect, test, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "node:fs";
import { bodyPath, sessionDir, errorPath, pidPath, stopPath } from "../src/paths.ts";
import { join } from "node:path";

const vault = "/tmp/voidos-server-test";

// Stub spawnTurn + runTurn before importing server.ts so routes don't fire real vc processes.
// Bun.mock.module replaces the module for all subsequent imports in this file.
const spawnCalls: Array<{ vault: string; uuid: string; argv: string[]; command: string }> = [];
const runTurnCalls: Array<{ cwd: string; vault: string; uuid: string; argv: string[]; command: string }> = [];
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
  runTurn: async (cwd: string, v: string, u: string, a: string[], cmd: string) => { runTurnCalls.push({ cwd, vault: v, uuid: u, argv: a, command: cmd }); return 0; },
}));

// Stub drain to avoid long-running loop in tests
const drainCalls: Array<unknown> = [];
mock.module("../src/drain.ts", () => ({
  drain: async (opts: unknown) => { drainCalls.push(opts); return { status: "complete", iterations: 0 }; },
}));

// Stub preflight to return authed by default (tests override per-test via module reload if needed)
mock.module("../src/preflight.ts", () => ({
  realDeps: {
    vcStatus: async () => ({ ok: true, msg: "authed" }),
  },
}));

// Import AFTER mock is registered
const { makeApp, buildDrainOptsFor } = await import("../src/server.ts");

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
  // Fix: redirect to /s/:uuid (not inline 200) so the shell wrapper stays visible
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("/s/multi-uuid");
  // Working page content must be written to body.html (not returned inline)
  const bodyHtml = readFileSync(bodyPath(vault, "multi-uuid"), "utf8");
  expect(bodyHtml).toContain("Alice");
  expect(bodyHtml).toContain("skill_deep-research");
  expect(bodyHtml).toContain("elapsed");
  // Spawned argv must include ALL fields
  expect(spawnCalls.length).toBe(before + 1);
  const lastArgv = spawnCalls[spawnCalls.length - 1].argv;
  const promptArg = lastArgv.find((a) => a.includes("name:"));
  expect(promptArg).toBeDefined();
  expect(promptArg).toContain("Alice");
});

test("POST /s/:uuid/send redirects to shell and writes working page into body.html", async () => {
  mkdirSync(sessionDir(vault, "send-uuid"), { recursive: true });
  writeFileSync(bodyPath(vault, "send-uuid"), "<title>s</title>hi");
  const before = spawnCalls.length;
  const app = makeApp(vault);
  const form = new FormData();
  form.append("text", "my answer");
  const res = await app.request("/s/send-uuid/send", { method: "POST", body: form });
  // Fix (VOS-186 v2): redirect to /s/:uuid so back-nav + Stop control stay visible
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("/s/send-uuid");
  // Working page is written to body.html so the iframe shows it
  const bodyHtml = readFileSync(bodyPath(vault, "send-uuid"), "utf8");
  expect(bodyHtml).toContain("received");
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

test("GET /s/:uuid/body injects base target=_top so in-body links escape the iframe", async () => {
  const id = "basetarget-uuid";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), '<h1>all set</h1><a href="/">return to dashboard</a>');
  const html = await (await makeApp(vault).request(`/s/${id}/body`)).text();
  expect(html).toContain('<base target="_top">');
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
  expect(res.status).toBe(302);
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

// --- Drain route tests ---

test("POST /drain with non-existent worktree returns 412", async () => {
  const app = makeApp(vault);
  const form = new FormData();
  form.append("issue", "99999");
  const res = await app.request("/drain", { method: "POST", body: form });
  expect(res.status).toBe(412);
  const text = await res.text();
  expect(text).toContain("does not exist");
});

test("GET / renders 'Agent inbox' section in dashboard", async () => {
  const app = makeApp(vault);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Agent inbox");
});

test("GET / agent-inbox lists an awaiting (human-parked) session", async () => {
  const awaitId = "await-drain-uuid";
  mkdirSync(sessionDir(vault, awaitId), { recursive: true });
  // body.html with <form so deriveStatus returns "awaiting"
  writeFileSync(bodyPath(vault, awaitId), `<title>ralph box review</title><form action="/s/${awaitId}/send" method="POST"><button>accept</button></form>`);
  writeFileSync(
    join(sessionDir(vault, awaitId), "session-meta.json"),
    JSON.stringify({ skill: "ralph", launchedAt: Date.now(), text: "drain #42", runner: "vc --", drainIssue: 42, worktree: "/tmp/drain-wt-test", max: 5 }),
  );
  const app = makeApp(vault);
  const res = await app.request("/");
  const html = await res.text();
  expect(html).toContain("awaiting verdict");
});

test("POST /s/:uuid/stop kills the child, marks stopped, and halts a drain", async () => {
  const uuid = "stop-route-uuid";
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>running</title><p>running</p>");
  // Spawn a detached child (group leader) so killProcessTree(-pid) can kill the whole group.
  // This matches the production spawn path (node:child_process.spawn { detached: true }).
  const { spawn: nodeSpawn } = await import("node:child_process");
  const child = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const childPid = child.pid!;
  writeFileSync(pidPath(vault, uuid), String(childPid));
  const wt = "/tmp/void-os-stop-wt";
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill: "x", drainIssue: 7, worktree: wt }));
  const app = makeApp(vault);
  const res = await app.request(`/s/${uuid}/stop`, { method: "POST" });
  expect(res.status).toBeLessThan(400);
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
  expect(existsSync(join(wt, "drain.stop"))).toBe(true);
  expect(existsSync(pidPath(vault, uuid))).toBe(false);
  // Give the OS a moment to reap the killed process
  await new Promise((r) => setTimeout(r, 200));
  // Verify child process group is gone
  let alive = true;
  try { process.kill(-childPid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("POST /stop writes a clean stopped body.html and clears a stale error.txt", async () => {
  const uuid = "stop-body-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>x</title><p>running…</p>");
  writeFileSync(errorPath(vault, uuid), "exit 143; body.html NOT updated"); // the stale banner
  const app = makeApp(vault);
  await app.request(`/s/${uuid}/stop`, { method: "POST" });
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
  expect(existsSync(errorPath(vault, uuid))).toBe(false);          // banner cleared
  expect(readFileSync(bodyPath(vault, uuid), "utf8")).toContain("stopped"); // clean terminal body
});

test("GET /body suppresses the exit-143 banner when stopped.txt exists", async () => {
  const uuid = "banner-suppress-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>x</title><p>stopped</p>");
  writeFileSync(errorPath(vault, uuid), "exit 143; body.html NOT updated");
  writeFileSync(stopPath(vault, uuid), "stopped\n");
  const app = makeApp(vault);
  const res = await app.request(`/s/${uuid}/body`);
  const body = await res.text();
  expect(body).not.toContain("NOT updated");
});

test("POST /stop on an already-stopped session is a no-op (idempotent)", async () => {
  const uuid = "restop-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>x</p>");
  const app = makeApp(vault);
  const r1 = await app.request(`/s/${uuid}/stop`, { method: "POST" });
  const r2 = await app.request(`/s/${uuid}/stop`, { method: "POST" }); // second stop
  expect(r1.status).toBeLessThan(400);
  expect(r2.status).toBeLessThan(400); // idempotent — no 500
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
});

test("GET /s/:uuid/status returns 'stopped' when stopped.txt present", async () => {
  const uuid = "status-stopped-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>done</p>");
  writeFileSync(stopPath(vault, uuid), "stopped\n");
  const app = makeApp(vault);
  const res = await app.request(`/s/${uuid}/status`);
  expect(await res.text()).toBe("stopped");
});

test("[BLOCKER] POST /s/:uuid/send on parked drain calls runTurn with cwd=worktree and triggers drain continuation", async () => {
  const parkedId = "parked-drain-uuid";
  const drainWorktree = "/tmp/drain-wt-parked";
  const drainIssue = 42;
  mkdirSync(sessionDir(vault, parkedId), { recursive: true });
  writeFileSync(bodyPath(vault, parkedId), `<title>review</title><form action="/s/${parkedId}/send" method="POST"><button>accept</button></form>`);
  writeFileSync(
    join(sessionDir(vault, parkedId), "session-meta.json"),
    JSON.stringify({ skill: "ralph", launchedAt: Date.now(), text: "drain #42", runner: "vc --", drainIssue, worktree: drainWorktree, max: 3 }),
  );

  const runTurnBefore = runTurnCalls.length;
  const drainBefore = drainCalls.length;

  const app = makeApp(vault);
  const form = new FormData();
  form.append("verdict", "accept");
  const res = await app.request(`/s/${parkedId}/send`, { method: "POST", body: form });
  expect(res.status).toBe(302);

  // runTurn must have been called with cwd = the worktree (NOT the vault)
  const newRunTurnCalls = runTurnCalls.slice(runTurnBefore);
  expect(newRunTurnCalls.length).toBe(1);
  expect(newRunTurnCalls[0].cwd).toBe(drainWorktree);
  expect(newRunTurnCalls[0].vault).toBe(vault);

  // Drain continuation is fire-and-forget (setTimeout 500ms); wait briefly
  await new Promise((r) => setTimeout(r, 600));
  const newDrainCalls = drainCalls.slice(drainBefore);
  expect(newDrainCalls.length).toBe(1);
});
