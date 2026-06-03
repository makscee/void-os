/**
 * T11: Server route integration test.
 * spawnTurn is stubbed via mock.module so no real `vc` process is spawned.
 * Tests: GET /, GET /s/:uuid, GET /s/:uuid/body (with + without error.txt), POST /s/:uuid/send.
 */
import { expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "node:fs";
import { bodyPath, sessionDir, errorPath, pidPath, stopPath } from "../src/paths.ts";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";

const vault = "/tmp/voidos-server-test";

/** Shared in-memory registry for the test suite. */
const db = openRegistry(":memory:");

// Stub spawnTurn + runTurn + spawnRun before importing server.ts so routes don't fire real vc processes.
// Bun.mock.module replaces the module for all subsequent imports in this file.
const spawnCalls: Array<{ vault: string; uuid: string; argv: string[]; command: string }> = [];
const runTurnCalls: Array<{ cwd: string; vault: string; uuid: string; argv: string[]; command: string }> = [];
const spawnRunCalls: Array<unknown> = [];
import { randomUUID } from "node:crypto";
// Load the real readCcSessionId via ?real specifier so the mock can delegate to it
// (the mock replaces spawn.ts, but transcript/resume routes need actual fs reads).
const { readCcSessionId: realReadCcSessionId } = await import("../src/spawn.ts?real");
mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => [
    "--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`,
    "--permission-mode", "bypassPermissions",
  ],
  buildAnswerArgv: (uuid: string, text: string, ccSessionId?: string | null) => [
    "--resume", ccSessionId ?? uuid, "-p", `[render contract: rewrite body.html, no terminal reply]\n${text}`,
    "--permission-mode", "bypassPermissions",
  ],
  // Delegate to the real readCcSessionId so transcript route resolves cc-actual + cc-command fallback.
  readCcSessionId: realReadCcSessionId,
  tokenizeCommand: (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean),
  spawnTurn: (v: string, u: string, a: string[], cmd: string) => { spawnCalls.push({ vault: v, uuid: u, argv: a, command: cmd }); },
  runTurn: async (cwd: string, v: string, u: string, a: string[], cmd: string) => { runTurnCalls.push({ cwd, vault: v, uuid: u, argv: a, command: cmd }); return 0; },
  spawnRun: (opts: { db: unknown; vault: string; daemonUrl: string; skill: string; agent: null; runnerCommand: string; now?: number }) => {
    const runId = `exec-${randomUUID()}`;
    const tmuxSession = `vos-run-${runId}`;
    spawnRunCalls.push({ ...opts, runId, tmuxSession });
    spawnCalls.push({ vault: opts.vault, uuid: runId, argv: [opts.skill], command: opts.runnerCommand });
    return { runId, tmuxSession };
  },
  // re-export VOS-206 functions so spawn.test.ts still works if mocks bleed across files
  buildInteractiveArgv: (ccSeed: string, vault: string, o: { addDirs?: string[]; mcpConfigPath?: string | null; settingsPath?: string | null }) => {
    const argv = ["--session-id", ccSeed, "--add-dir", vault, "--permission-mode", "bypassPermissions"];
    if (o.settingsPath) argv.push("--settings", o.settingsPath);
    for (const d of o.addDirs ?? []) argv.push("--add-dir", d);
    return argv;
  },
  buildWrapperCommand: (wrapperPath: string, daemonUrl: string, runId: string, mode: string, ccCommand: string) =>
    `"${wrapperPath}" "${daemonUrl}" "${runId}" "${mode}" ${ccCommand}`,
  buildSpawnArgv: () => [],
  hookRelayScriptPath: "/mock/hook-relay.sh",
  runWrapperScriptPath: "/mock/run-wrapper.sh",
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
  // re-export checkPrereqs so preflight.test.ts still works if mocks bleed across files
  checkPrereqs: async (deps: { which: (b: string) => Promise<boolean>; vcStatus: () => Promise<{ ok: boolean; text: string }> }) => {
    const problems: string[] = [];
    let needsLogin = false;
    const [hasVc, hasClaude] = await Promise.all([deps.which("vc"), deps.which("claude")]);
    if (!hasVc) problems.push("vc not found — install via: curl -fsSL https://auth.makscee.ru/cv/install.sh | sh");
    if (!hasClaude) problems.push("claude not found — install Claude Code CLI");
    if (hasVc) {
      const status = await deps.vcStatus();
      if (!status.ok) { needsLogin = true; problems.push("vc not logged in — run: vc login"); }
    }
    return { ok: problems.length === 0, needsLogin, problems };
  },
  productionDeps: () => ({ which: async () => true, vcStatus: async () => ({ ok: true, text: "ok" }) }),
  checkPreflight: async () => ({ ok: true, needsLogin: false, problems: [] }),
}));

// VOS-205: stub tmux functions used by the new routes (no real tmux sessions in unit tests).
const switchTargets: string[] = [];
const sentKeys: Array<[string, string]> = [];
const hasSessionMap: Map<string, boolean> = new Map();
mock.module("../src/tmux.ts", () => ({
  hasSession: (name: string) => hasSessionMap.get(name) ?? false,
  switchClient: (target: string) => { switchTargets.push(target); return { code: 0, stderr: "" }; },
  sendKeys: (target: string, line: string) => { sentKeys.push([target, line]); },
  killSession: (_name: string) => {},
  newRunSession: (_name: string, _cwd: string, _cmd: string, _env: Record<string, string>) => 0,
  listVosSessions: () => [],
  attachCommand: (name: string) => `tmux -L vos attach -t ${name}`,
  capturePaneContent: () => "",
  waitForPrompt: async () => true,
  VOS_SOCKET: "vos",
}));

// VOS-205: stub resume.ts so no real CC/tmux launched in unit tests.
const respawnCalls: string[] = [];
mock.module("../src/resume.ts", () => ({
  respawnSession: (_db: unknown, _vault: string, execId: string, _runner: string, _daemonUrl: string) => {
    respawnCalls.push(execId);
    hasSessionMap.set(`vos-run-${execId}`, true); // mark session as live after respawn
    return `vos-run-${execId}`;
  },
  buildResumeArgv: (ccId: string, vault: string, _o: unknown) => [
    "--resume", ccId, "--add-dir", vault, "--permission-mode", "bypassPermissions",
  ],
  // re-export ensureRawRunner so resume.test.ts still works if mocks bleed across files
  ensureRawRunner: (cmd: string) => {
    const toks = cmd.trim().split(/\s+/).filter(Boolean);
    const sepIdx = toks.indexOf("--");
    if (sepIdx !== -1 && !toks.includes("--raw")) toks.splice(sepIdx, 0, "--raw");
    return toks;
  },
}));

// Import AFTER mock is registered
const { makeApp, buildDrainOptsFor } = await import("../src/server.ts");

beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(`${vault}/sessions`, { recursive: true });
});

test("GET / renders dashboard with void-os title", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("void-os");
});

test("GET /s/:uuid/body serves body.html content", async () => {
  mkdirSync(sessionDir(vault, "u9"), { recursive: true });
  writeFileSync(bodyPath(vault, "u9"), "<title>u9</title>BODY_CONTENT");
  const app = makeApp(vault, db);
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
  const app = makeApp(vault, db);
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
  const app = makeApp(vault, db);
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
  const app = makeApp(vault, db);
  const html = await (await app.request(`/s/${id}/body`)).text();
  expect(html).toContain("session starting");
  // timeout banner MUST appear — skill never produced output
  expect(html).toContain("timeout");
});

test("GET /s/:uuid/body returns 404 when no body.html", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/s/no-such-uuid/body");
  expect(res.status).toBe(404);
});

test("GET /s/:uuid returns the iframe shell with correct src", async () => {
  const html = await (await makeApp(vault, db).request("/s/u9")).text();
  expect(html).toContain('src="/s/u9/body"');
  expect(html).toContain("/s/u9/stream");
  // Vault path still appears in the page (e.g. session name or CSS)
  // Note: resume cmd is suppressed when cc-actual-session.txt is absent (VOS-215 BUG C fix)
  expect(html).toContain("u9");
});

test("POST /s/:uuid/send serializes ALL form fields (Bug #1 fix)", async () => {
  mkdirSync(sessionDir(vault, "multi-uuid"), { recursive: true });
  writeFileSync(bodyPath(vault, "multi-uuid"), "<title>s</title>hi");
  const beforeSpawn = spawnRunCalls.length;
  const beforeKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("name", "Alice");
  form.append("skill_deep-research", "on");
  const res = await app.request("/s/multi-uuid/send", { method: "POST", body: form });
  // VOS-211: unified send path — redirects back to the SAME session, no successor spawn.
  expect(res.status).toBe(302);
  const loc = res.headers.get("location") ?? "";
  expect(loc).toBe("/s/multi-uuid");
  // NO new exec row created (unified send path: same-thread resume, no successor).
  expect(spawnRunCalls.length).toBe(beforeSpawn);
  // Form fields arrived serialized in the sendKeys call.
  const sent = sentKeys.slice(beforeKeys);
  const line = sent.at(-1)?.[1] ?? "";
  expect(line).toContain("name: Alice");
  expect(line).toContain("skill_deep-research: on");
});

test("POST /s/:uuid/send redirects back to same session and writes working page", async () => {
  mkdirSync(sessionDir(vault, "send-uuid"), { recursive: true });
  writeFileSync(bodyPath(vault, "send-uuid"), "<title>s</title>hi");
  const before = spawnRunCalls.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("text", "my answer");
  const res = await app.request("/s/send-uuid/send", { method: "POST", body: form });
  // VOS-211: unified send path — redirects back to the SAME session, no successor spawn.
  expect(res.status).toBe(302);
  const loc = res.headers.get("location") ?? "";
  expect(loc).toBe("/s/send-uuid");
  // NO new exec row created (unified send path: same-thread resume, no successor).
  expect(spawnRunCalls.length).toBe(before);
});

/**
 * SSE keepalive regression test (VOS-181):
 * The /stream route must emit a ": ping" SSE comment within PING_INTERVAL_MS (5s)
 * even when body.html does NOT change — this keeps the connection alive during cold starts
 * and prevents Bun's idleTimeout from killing the socket.
 */
test("GET /s/:uuid/stream emits SSE keepalive ping within 6s when body.html does not change", async () => {
  const id = "stream-keepalive-test";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  const bp = bodyPath(vault, id);
  writeFileSync(bp, "<title>k</title>waiting");
  const past = new Date(Date.now() - 10_000);
  utimesSync(bp, past, past);

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${id}/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

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
      if (collected.join("").includes(": ping")) break outer;
    }
  }
  reader.cancel();

  const fullText = collected.join("");
  expect(fullText).toContain(": ping");
}, 10_000);

// Bug 2: /s/:uuid shell should show session skill name in header, not raw uuid
test("GET /s/:uuid shows skill name in header when session-meta.json exists", async () => {
  const id = "u-named-session";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<title>s</title>body");
  writeFileSync(
    join(sessionDir(vault, id), "session-meta.json"),
    JSON.stringify({ skill: "smoke-test", launchedAt: Date.now(), text: "", runner: "vc --" }),
  );
  const html = await (await makeApp(vault, db).request(`/s/${id}`)).text();
  expect(html).toContain("smoke-test");
  expect(html).not.toMatch(/class="session-name"[^>]*>u-named-session</);
});

// Bug 1: /s/:uuid/body should wrap bare HTML fragments in a light-themed document
test("GET /s/:uuid/body wraps bare fragment with readable light-theme CSS", async () => {
  const id = "u-bare-body";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<h1>smoke-test ✓ session live</h1><p>no input</p>");
  const html = await (await makeApp(vault, db).request(`/s/${id}/body`)).text();
  expect(html).toContain("color");
  expect(html).toContain("background");
  expect(html).toContain("smoke-test ✓ session live");
});

test("GET /s/:uuid/body does NOT double-wrap full HTML documents", async () => {
  const id = "u-full-html-body";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<!doctype html><html><head><title>t</title></head><body>full</body></html>");
  const html = await (await makeApp(vault, db).request(`/s/${id}/body`)).text();
  expect(html.split("<!doctype html").length).toBe(2);
  expect(html).toContain("full");
});

test("GET /s/:uuid/body injects base target=_top so in-body links escape the iframe", async () => {
  const id = "basetarget-uuid";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), '<h1>all set</h1><a href="/">return to dashboard</a>');
  const html = await (await makeApp(vault, db).request(`/s/${id}/body`)).text();
  expect(html).toContain('<base target="_top">');
});

test("POST /launch writes placeholder + session-meta.json, calls spawnRun, redirects", async () => {
  const before = spawnCalls.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("skill", "deep-research");
  form.append("text", "AI safety");
  const res = await app.request("/launch", { method: "POST", body: form });
  // redirect to /s/<exec-id>
  expect(res.status).toBe(302);
  const loc = res.headers.get("location") ?? "";
  // exec-<uuid> format
  expect(loc).toMatch(/^\/s\/exec-[0-9a-f-]{36}$/);
  expect(spawnCalls.length).toBe(before + 1);
  const lastArgv = spawnCalls[spawnCalls.length - 1].argv;
  expect(lastArgv.some((a) => a.includes("deep-research"))).toBe(true);
  // session-meta.json must be written with skill name
  const execId = loc.replace("/s/", "");
  const meta = JSON.parse(readFileSync(join(sessionDir(vault, execId), "session-meta.json"), "utf8"));
  expect(meta.skill).toBe("deep-research");
  expect(meta.text).toBe("AI safety");
});

test("POST /launch persists resolved runner command in session-meta", async () => {
  writeFileSync(
    join(vault, "void-os.json"),
    JSON.stringify({
      vault, onboarded: true, skills: [], answers: {}, port: 4317,
      runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }],
      defaultRunner: "vc (relay)",
    }),
  );
  const before = spawnCalls.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("skill", "smoke-test");
  form.append("text", "");
  form.append("runner", "artem");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  const execId = res.headers.get("location")!.split("/s/")[1];
  const meta = JSON.parse(readFileSync(join(sessionDir(vault, execId), "session-meta.json"), "utf8"));
  expect(meta.runner).toBe("claude_artem");
  expect(spawnCalls[spawnCalls.length - 1].command).toBe("claude_artem");
});

test("POST /s/:uuid/send reuses runner from session-meta (unified send path: same-thread resume)", async () => {
  const id = "resume-runner-uuid";
  mkdirSync(sessionDir(vault, id), { recursive: true });
  writeFileSync(bodyPath(vault, id), "<title>r</title>hi");
  writeFileSync(
    join(sessionDir(vault, id), "session-meta.json"),
    JSON.stringify({ skill: "smoke-test", launchedAt: Date.now(), text: "", runner: "claude_artem" }),
  );
  hasSessionMap.set(`vos-run-${id}`, false); // reaped so respawn is triggered
  const beforeSpawn = spawnRunCalls.length;
  const beforeRespawn = respawnCalls.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("text", "echo: hello");
  const res = await app.request(`/s/${id}/send`, { method: "POST", body: form });
  expect(res.status).toBe(302);
  // VOS-211: unified send path — no new exec row, respawns same thread using the session's runner.
  expect(spawnRunCalls.length).toBe(beforeSpawn);
  expect(respawnCalls.slice(beforeRespawn)).toContain(id);
});

// VOS-211: unified send path — worker (interactive:false) resumes its OWN thread, no successor spawn.
test("POST /s/:uuid/send on a worker (interactive:false) resumes its OWN thread — no successor spawn", async () => {
  const uuid = "exec-worker-resume";
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  // A finished worker: NOT interactive, NO drainIssue. Wrote cc-actual-session.txt → resumable.
  writeFileSync(join(dir, "session-meta.json"),
    JSON.stringify({ skill: "skill-author", interactive: false, tmuxSession: `vos-run-${uuid}`, runner: "vc --" }));
  writeFileSync(join(dir, "cc-actual-session.txt"), "12345678-1234-1234-1234-1234567890ab");
  hasSessionMap.set(`vos-run-${uuid}`, false);   // reaped: worker finished, pane gone
  const beforeSpawn = spawnRunCalls.length;
  const beforeRespawn = respawnCalls.length;
  const beforeKeys = sentKeys.length;

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/send`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ answer: "continue the skill" }),
  });

  expect(res.status).toBeLessThan(400);
  // THE worker-resume invariant: NO new exec row created.
  expect(spawnRunCalls.length).toBe(beforeSpawn);
  // It respawned + resumed THIS uuid's own thread...
  expect(respawnCalls.slice(beforeRespawn)).toContain(uuid);
  // ...and sent the input to the SAME uuid's tmux session.
  const sent = sentKeys.slice(beforeKeys);
  expect(sent.at(-1)?.[0]).toBe(`vos-run-${uuid}`);
  expect(sent.at(-1)?.[1]).toContain("answer: continue the skill");
});

// VOS-211: /act route tests
test("POST /s/:uuid/act sends to the live session, returns ack fragment, advances body.html", async () => {
  const uuid = "exec-act-live";
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill: "x", interactive: true }));
  writeFileSync(bodyPath(vault, uuid), "<html><body>old</body></html>");
  hasSessionMap.set(`vos-run-${uuid}`, true);
  const before = readFileSync(bodyPath(vault, uuid), "utf8");
  const beforeKeys = sentKeys.length;

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/act`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ answer: "ship it", choice: "yes" }),
  });

  expect(res.status).toBe(200);
  const frag = await res.text();
  expect(frag).toContain("working");                       // ack fragment returned
  expect(frag).not.toContain("<html");                      // fragment, not full doc
  const sent = sentKeys.slice(beforeKeys);
  expect(sent.at(-1)?.[0]).toBe(`vos-run-${uuid}`);         // same send path as the chat box
  expect(sent.at(-1)?.[1]).toContain("answer: ship it");
  expect(sent.at(-1)?.[1]).toContain("choice: yes");
  // body.html replaced with workingPage so SSE reload fires
  const after = readFileSync(bodyPath(vault, uuid), "utf8");
  expect(after).not.toBe(before);
  expect(after).toContain("working");
});

test("POST /s/:uuid/act on a reaped session respawns (--resume) then sends — no lost message", async () => {
  const uuid = "exec-act-reaped";
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill: "x", interactive: true }));
  writeFileSync(join(dir, "cc-actual-session.txt"), "12345678-1234-1234-1234-1234567890ab");
  hasSessionMap.set(`vos-run-${uuid}`, false);     // reaped pane
  const beforeRespawn = respawnCalls.length;
  const beforeKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/act`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ answer: "resume me" }),
  });
  expect(res.status).toBe(200);
  expect(respawnCalls.slice(beforeRespawn)).toContain(uuid);   // respawned this uuid
  expect(sentKeys.slice(beforeKeys).at(-1)?.[1]).toContain("answer: resume me");  // send AFTER respawn
});

test("POST /s/:uuid/act rejects a path-traversal session id", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/s/..%2F..%2Fetc/act", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ x: "1" }),
  });
  expect(res.status).toBe(400);
});

// VOS-211: B2 — htmx asset route + UUID substitution
test("GET /assets/htmx.min.js serves the vendored runtime", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/assets/htmx.min.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect((await res.text()).length).toBeGreaterThan(1000);
});

test("GET /s/:uuid/body injects htmx and substitutes {{VOS_UUID}}", async () => {
  const uuid = "exec-sub-uuid";
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid),
    `<!doctype html><html><head></head><body><form hx-post="/s/{{VOS_UUID}}/act"></form></body></html>`);
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/body`);
  const out = await res.text();
  expect(out).toContain(`hx-post="/s/${uuid}/act"`);
  expect(out).not.toContain("{{VOS_UUID}}");
  expect(out).toContain("htmx.min.js");
});

test("GET /s/:uuid/body returns a complete standalone doc wired on cold load (dead-render)", async () => {
  const uuid = "exec-cold";
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid),
    `<!doctype html><html><head><title>t</title></head><body><form hx-post="/s/{{VOS_UUID}}/act"><button>go</button></form></body></html>`);
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/body`);
  const out = await res.text();
  expect(out).toContain("<html");                 // full doc, not a fragment-only response
  expect(out).toContain("htmx.min.js");            // runtime present without any SSE event
  expect(out).toContain(`/s/${uuid}/act`);          // form is wired on cold load
});

// VOS-204: transcript route must translate void-os runId → CC session id via cc-actual-session.txt.
// Test 1: runId (exec-...) with cc-actual-session.txt → renders turns from the CC jsonl.
test("GET /s/:uuid/transcript renders turns when uuid is a runId and cc-actual-session.txt is present", async () => {
  const runId = `exec-vos204-test-${Date.now()}`;
  const ccId = "bb22c3d4-e5f6-7890-abcd-ef1234560204";
  const dir = sessionDir(vault, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cc-actual-session.txt"), ccId);
  const proj = join(process.env.HOME!, ".claude", "projects", "-voidos-server-test-vos204");
  mkdirSync(proj, { recursive: true });
  const txFile = join(proj, `${ccId}.jsonl`);
  writeFileSync(
    txFile,
    `{"type":"user","message":{"role":"user","content":"hello from vos204"}}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply <ok>"}]}}\n`,
  );
  try {
    const app = makeApp(vault, db);
    const res = await app.request(`/s/${runId}/transcript`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from vos204");
    expect(body).toContain("reply &lt;ok&gt;");
  } finally {
    try { rmSync(txFile); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

// VOS-204: when cc-actual-session.txt is absent (run not yet started), return empty HTML.
test("GET /s/:uuid/transcript returns empty body when cc-actual-session.txt is missing", async () => {
  const runId = `exec-vos204-no-cc-${Date.now()}`;
  const dir = sessionDir(vault, runId);
  mkdirSync(dir, { recursive: true });
  // No cc-actual-session.txt written
  try {
    const app = makeApp(vault, db);
    const res = await app.request(`/s/${runId}/transcript`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  } finally {
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

test("GET /s/:uuid/transcript returns strictly empty body for unknown uuid", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/s/99999999-8888-7777-6666-555555555555/transcript");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
});

// VOS-209 Task 3: transcript route must fall back to cc-command.txt --session-id when cc-actual is absent
test("VOS-209: GET /s/:uuid/transcript resolves via cc-command.txt --session-id when cc-actual missing", async () => {
  const runId = `exec-vos209-fallback-${Date.now()}`;
  const ccId = "cc209aaa-e5f6-7890-abcd-ef1234560209";
  const dir = sessionDir(vault, runId);
  mkdirSync(dir, { recursive: true });
  // Write cc-command.txt with --session-id hint (no cc-actual-session.txt)
  writeFileSync(
    join(dir, "cc-command.txt"),
    `vc -- claude --session-id ${ccId} --add-dir /tmp/vault --permission-mode bypassPermissions`,
  );
  // Write the CC jsonl using the hint ID
  const proj = join(process.env.HOME!, ".claude", "projects", "-voidos-server-test-vos209");
  mkdirSync(proj, { recursive: true });
  const txFile = join(proj, `${ccId}.jsonl`);
  writeFileSync(
    txFile,
    `{"type":"user","message":{"role":"user","content":"hello from vos209 fallback"}}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply via fallback"}]}}\n`,
  );
  try {
    const app = makeApp(vault, db);
    const res = await app.request(`/s/${runId}/transcript`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from vos209 fallback");
    expect(body).toContain("reply via fallback");
  } finally {
    try { rmSync(txFile); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

// --- Drain route tests ---

test("POST /drain with non-existent worktree returns 412", async () => {
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("issue", "99999");
  const res = await app.request("/drain", { method: "POST", body: form });
  expect(res.status).toBe(412);
  const text = await res.text();
  expect(text).toContain("does not exist");
});

test("GET / renders 'Agent inbox' section in dashboard", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Agent inbox");
});

test("GET / agent-inbox lists an awaiting (human-parked) session", async () => {
  const awaitId = "await-drain-uuid";
  mkdirSync(sessionDir(vault, awaitId), { recursive: true });
  writeFileSync(bodyPath(vault, awaitId), `<title>ralph box review</title><form action="/s/${awaitId}/send" method="POST"><button>accept</button></form>`);
  writeFileSync(
    join(sessionDir(vault, awaitId), "session-meta.json"),
    JSON.stringify({ skill: "ralph", launchedAt: Date.now(), text: "drain #42", runner: "vc --", drainIssue: 42, worktree: "/tmp/drain-wt-test", max: 5 }),
  );
  const app = makeApp(vault, db);
  const res = await app.request("/");
  const html = await res.text();
  expect(html).toContain("awaiting verdict");
});

test("POST /s/:uuid/stop kills the child, marks stopped, and halts a drain", async () => {
  const uuid = "stop-route-uuid";
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>running</title><p>running</p>");
  const { spawn: nodeSpawn } = await import("node:child_process");
  const child = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const childPid = child.pid!;
  writeFileSync(pidPath(vault, uuid), String(childPid));
  const wt = "/tmp/void-os-stop-wt";
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ skill: "x", drainIssue: 7, worktree: wt }));
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/stop`, { method: "POST" });
  expect(res.status).toBeLessThan(400);
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
  expect(existsSync(join(wt, "drain.stop"))).toBe(true);
  expect(existsSync(pidPath(vault, uuid))).toBe(false);
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try { process.kill(-childPid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("POST /stop writes a clean stopped body.html and clears a stale error.txt", async () => {
  const uuid = "stop-body-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>x</title><p>running…</p>");
  writeFileSync(errorPath(vault, uuid), "exit 143; body.html NOT updated");
  const app = makeApp(vault, db);
  await app.request(`/s/${uuid}/stop`, { method: "POST" });
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
  expect(existsSync(errorPath(vault, uuid))).toBe(false);
  expect(readFileSync(bodyPath(vault, uuid), "utf8")).toContain("stopped");
});

test("GET /body suppresses the exit-143 banner when stopped.txt exists", async () => {
  const uuid = "banner-suppress-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>x</title><p>stopped</p>");
  writeFileSync(errorPath(vault, uuid), "exit 143; body.html NOT updated");
  writeFileSync(stopPath(vault, uuid), "stopped\n");
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/body`);
  const body = await res.text();
  expect(body).not.toContain("NOT updated");
});

test("POST /stop on an already-stopped session is a no-op (idempotent)", async () => {
  const uuid = "restop-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>x</p>");
  const app = makeApp(vault, db);
  const r1 = await app.request(`/s/${uuid}/stop`, { method: "POST" });
  const r2 = await app.request(`/s/${uuid}/stop`, { method: "POST" });
  expect(r1.status).toBeLessThan(400);
  expect(r2.status).toBeLessThan(400);
  expect(existsSync(stopPath(vault, uuid))).toBe(true);
});

test("GET /s/:uuid/status returns 'stopped' when stopped.txt present", async () => {
  const uuid = "status-stopped-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>done</p>");
  writeFileSync(stopPath(vault, uuid), "stopped\n");
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/status`);
  expect(await res.text()).toBe("stopped");
});

// VOS-208: /status route uses statusFor — agrees with dashboard dot for exec-row states
test("GET /s/:uuid/status returns 'error' for exec with reason (false-green regression)", async () => {
  const { createExecution, setExecutionFail } = await import("../src/registry.ts");
  const uuid = "status-error-exec-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>failed run</p>");
  createExecution(db, { id: uuid, agent: null, skill: null, inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: 1000, triggerId: null, stepCeiling: null });
  setExecutionFail(db, uuid, "runaway-ceiling", 2000);
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/status`);
  expect(await res.text()).toBe("error");
});

test("GET /s/:uuid/status returns 'reaped' for stranded form + ended exec (stranded-yellow regression)", async () => {
  const { createExecution, setExecutionEnded } = await import("../src/registry.ts");
  const { reapedPath } = await import("../src/paths.ts");
  const uuid = "status-reaped-stranded-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>body</p><form action='/send'><input></form>");
  createExecution(db, { id: uuid, agent: null, skill: null, inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: 1000, triggerId: null, stepCeiling: null });
  setExecutionEnded(db, uuid, 2000);
  // ended + form present → reaped (stranded-yellow fix)
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/status`);
  expect(await res.text()).toBe("reaped");
});

test("GET /s/:uuid/status returns 'working' for live exec without form", async () => {
  const { createExecution } = await import("../src/registry.ts");
  const uuid = "status-working-uuid";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>running…</p>");
  createExecution(db, { id: uuid, agent: null, skill: null, inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: 1000, triggerId: null, stepCeiling: null });
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/status`);
  expect(await res.text()).toBe("working");
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

  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("verdict", "accept");
  const res = await app.request(`/s/${parkedId}/send`, { method: "POST", body: form });
  expect(res.status).toBe(302);

  const newRunTurnCalls = runTurnCalls.slice(runTurnBefore);
  expect(newRunTurnCalls.length).toBe(1);
  expect(newRunTurnCalls[0].cwd).toBe(drainWorktree);
  expect(newRunTurnCalls[0].vault).toBe(vault);

  await new Promise((r) => setTimeout(r, 600));
  const newDrainCalls = drainCalls.slice(drainBefore);
  expect(newDrainCalls.length).toBe(1);
});

// --- VOS-190: POST /hook PreToolUse breach via real route ---

test("POST /hook PreToolUse breach marks the trigger execution failed with runaway-ceiling", async () => {
  const { createExecution, getExecution } = await import("../src/registry.ts");
  createExecution(db, { id: "hook-exec", agent: "a", skill: "sk", inputRef: null,
    tmuxSession: "vos-run-nope", now: 0, triggerId: "t", stepCeiling: 1 });
  const app = makeApp(vault, db);
  const res = await app.fetch(new Request("http://x/hook?run=hook-exec", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cc" }),
  }));
  expect(res.status).toBe(200);
  const row = getExecution(db, "hook-exec")!;
  expect(row.reason).toBe("runaway-ceiling");
  expect(row.ended_at).not.toBeNull();
});

// --- Task 9 test: POST /triggers/:name/fire manual fire route ---

test("POST /triggers/:name/fire fires the trigger and stamps last_fired_at", async () => {
  const { upsertTrigger, getTrigger } = await import("../src/registry.ts");
  upsertTrigger(db, { name: "fire-m", kind: "manual", skill: "x", agent: "a", cronExpr: null, inbox: null, stepCeiling: 50, now: 0 });
  const fakeSpawn = () => ({ runId: "exec-fake", tmuxSession: "vos-run-exec-fake" });
  const app = makeApp(vault, db, fakeSpawn);
  const res = await app.request("/triggers/fire-m/fire", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json() as { runId: string };
  expect(body.runId).toBe("exec-fake");
  expect(getTrigger(db, "fire-m")!.last_fired_at).not.toBeNull();
});

test("POST /triggers/:name/fire returns 404 for unknown trigger", async () => {
  const fakeSpawn = () => ({ runId: "r", tmuxSession: "t" });
  const app = makeApp(vault, db, fakeSpawn);
  const res = await app.request("/triggers/no-such-trigger/fire", { method: "POST" });
  expect(res.status).toBe(404);
});

// --- VOS-190: executions list on dashboard ---

test("GET / dashboard lists executions section", async () => {
  const app = makeApp(vault, db);
  const res = await app.request("/");
  const html = await res.text();
  expect(res.status).toBe(200);
  // Dashboard must render — presence of Sessions section confirms executions list
  expect(html).toContain("Sessions");
});

// --- VOS-197: /hook route derives runId from session_id (vault-level / hand-launch path) ---

test("/hook derives runId from session_id when ?run= absent (vault-level hand-launch path)", async () => {
  const { getExecution } = await import("../src/registry.ts");
  const { runIdForSession } = await import("../src/hooks-endpoint.ts");

  const app = makeApp(vault, db);
  const sessionId = `sess-route-vos197-${Date.now()}`;
  const expectedRunId = runIdForSession(sessionId);

  // Pre-check: row does not exist yet
  expect(getExecution(db, expectedRunId)).toBeNull();

  const res = await app.request("/hook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, source: "startup" }),
  });
  expect(res.status).toBe(200);

  // Row must now exist (SessionStart created it via hand-launch path)
  const row = getExecution(db, expectedRunId);
  expect(row).not.toBeNull();
  expect(row!.trigger_id).toBeNull();   // hand-launched: no trigger
  expect(row!.ended_at).toBeNull();     // still running
});

test("/hook uses ?run= param when present (daemon-spawned path unaffected)", async () => {
  const { createExecution, getExecution } = await import("../src/registry.ts");

  const app = makeApp(vault, db);
  const runId = `exec-daemon-server-test-${Date.now()}`;
  createExecution(db, { id: runId, agent: null, skill: "x", inputRef: null,
    tmuxSession: `vos-run-${runId}`, now: 1000, triggerId: null, stepCeiling: null });

  const res = await app.request(`/hook?run=${runId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "does-not-matter" }),
  });
  expect(res.status).toBe(200);

  // Row must be closed by SessionEnd (daemon path unchanged)
  const row = getExecution(db, runId);
  expect(row!.ended_at).not.toBeNull();
});

// VOS-203: dashboard reads vault .claude/skills/, not the repo catalog
test("GET / dashboard shows vault-installed skills, not catalog-only skills", async () => {
  const testVault = "/tmp/voidos-server-test-vos203";
  rmSync(testVault, { recursive: true, force: true });
  mkdirSync(`${testVault}/sessions`, { recursive: true });
  // Seed two vault skills
  mkdirSync(`${testVault}/.claude/skills/vault-skill-one`, { recursive: true });
  writeFileSync(`${testVault}/.claude/skills/vault-skill-one/SKILL.md`,
    "---\nname: vault-skill-one\ndescription: First vault skill.\nversion: 0.0.0\n---\n");
  mkdirSync(`${testVault}/.claude/skills/vault-skill-two`, { recursive: true });
  writeFileSync(`${testVault}/.claude/skills/vault-skill-two/SKILL.md`,
    "---\nname: vault-skill-two\ndescription: Second vault skill.\nversion: 0.0.0\n---\n");

  const testDb = openRegistry(":memory:");
  const app = makeApp(testVault, testDb);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const text = await res.text();
  // Must show vault-installed skills
  expect(text).toContain('data-skill="vault-skill-one"');
  expect(text).toContain('data-skill="vault-skill-two"');
  // Must NOT show catalog-only skills that were not installed in vault
  expect(text).not.toContain('data-skill="deep-research"');
  expect(text).not.toContain('data-skill="work"');

  rmSync(testVault, { recursive: true, force: true });
});

// --- VOS-205 T5: new interactive-session routes ---

test("POST /s/:uuid/attach-here switch-clients to a live session", async () => {
  const uuid = `attach-test-${Date.now()}`;
  // Seed session dir + meta + registry row so the route resolves
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>live</p>");
  const { createExecution } = await import("../src/registry.ts");
  createExecution(db, { id: uuid, agent: null, skill: "chat", inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: Date.now(), triggerId: null, stepCeiling: null });
  writeFileSync(join(sessionDir(vault, uuid), "session-meta.json"),
    JSON.stringify({ skill: "chat", interactive: true, tmuxSession: `vos-run-${uuid}` }));

  // Mark session as live so attach-here goes directly to switchClient
  hasSessionMap.set(`vos-run-${uuid}`, true);
  const prevLen = switchTargets.length;

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/attach-here`, { method: "POST" });
  expect(res.status).toBe(200);
  // switchClient must have been called with the correct target
  expect(switchTargets.slice(prevLen)).toContain(`vos-run-${uuid}`);
});

test("POST /s/:uuid/message send-keys into a live session", async () => {
  const uuid = `msg-live-${Date.now()}`;
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>live</p>");
  const { createExecution } = await import("../src/registry.ts");
  createExecution(db, { id: uuid, agent: null, skill: "chat", inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: Date.now(), triggerId: null, stepCeiling: null });
  writeFileSync(join(sessionDir(vault, uuid), "session-meta.json"),
    JSON.stringify({ skill: "chat", interactive: true, tmuxSession: `vos-run-${uuid}` }));

  hasSessionMap.set(`vos-run-${uuid}`, true);
  const prevKeys = sentKeys.length;

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/message`, {
    method: "POST",
    body: new URLSearchParams({ text: "hello there" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(200);
  const sent = sentKeys.slice(prevKeys).map(([t, l]) => [t, l]);
  expect(sent.some(([t, l]) => t === `vos-run-${uuid}` && l === "hello there")).toBe(true);
});

test("POST /s/:uuid/message on a reaped session respawns then send-keys", async () => {
  const uuid = `msg-reaped-${Date.now()}`;
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>reaped</p>");
  const { createExecution } = await import("../src/registry.ts");
  createExecution(db, { id: uuid, agent: null, skill: "chat", inputRef: null,
    tmuxSession: `vos-run-${uuid}`, now: Date.now(), triggerId: null, stepCeiling: null });
  writeFileSync(join(sessionDir(vault, uuid), "session-meta.json"),
    JSON.stringify({ skill: "chat", interactive: true, tmuxSession: `vos-run-${uuid}` }));
  // Write cc-actual-session.txt so respawnSession can resolve ccId
  writeFileSync(join(sessionDir(vault, uuid), "cc-actual-session.txt"), "a1b2c3d4-0000-0000-0000-000000000001");

  // Session is reaped: hasSession returns false
  hasSessionMap.set(`vos-run-${uuid}`, false);
  const prevRespawn = respawnCalls.length;
  const prevKeys = sentKeys.length;

  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/message`, {
    method: "POST",
    body: new URLSearchParams({ text: "after reap" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(200);
  // respawnSession was called for the reaped session
  expect(respawnCalls.slice(prevRespawn)).toContain(uuid);
  // send-keys was then called
  const sent = sentKeys.slice(prevKeys).map(([t, l]) => [t, l]);
  expect(sent.some(([t, l]) => t === `vos-run-${uuid}` && l === "after reap")).toBe(true);
});

test("POST /s/:uuid/message returns 400 when text is empty", async () => {
  const uuid = `msg-empty-${Date.now()}`;
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  const app = makeApp(vault, db);
  const res = await app.request(`/s/${uuid}/message`, {
    method: "POST",
    body: new URLSearchParams({ text: "" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(400);
});

// ── VOS-210 T2: ccId-form resume command ──────────────────────────────────

test("GET /s/:uuid renders ccId-form vc --resume when cc-actual-session.txt exists", async () => {
  const uuid = `vos-210-resume-${Date.now()}`;
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  // readCcSessionId validates UUID format: /^[0-9a-f-]{36}$/
  const fakeCcId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeFileSync(join(dir, "cc-actual-session.txt"), fakeCcId);
  const html = await (await makeApp(vault, db).request(`/s/${uuid}`)).text();
  expect(html).toContain(`vc -- --resume ${fakeCcId}`);
  expect(html).not.toContain("tmux -L vos attach");
});

test("GET /s/:uuid suppresses resume cmd when cc-actual-session.txt is absent (VOS-215 BUG C fix)", async () => {
  // VOS-215: before ccId exists, the copy button shows "starting…" rather than
  // emitting --resume <runId> (which is not a valid CC --resume target).
  const uuid = `vos-210-noresume-${Date.now()}`;
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  const html = await (await makeApp(vault, db).request(`/s/${uuid}`)).text();
  // Must NOT expose runId as a --resume target (would silently fail at the operator)
  expect(html).not.toContain(`vc -- --resume ${uuid}`);
  // Must not expose any tmux target either
  expect(html).not.toContain("tmux -L vos attach");
  // Shows the "starting…" placeholder instead
  expect(html).toContain("starting…");
});

// ── VOS-210 T3: state-derived view tests ──────────────────────────────────

test("GET /s/:uuid with placeholder-only body includes attach + message affordances (chat is primary)", async () => {
  const uuid = `vos-210-placeholder-${Date.now()}`;
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  // Write placeholder body (what spawn seeds before skill runs)
  const { placeholderBody } = await import("../src/render.ts");
  writeFileSync(join(dir, "body.html"), placeholderBody("skill-author"));
  const html = await (await makeApp(vault, db).request(`/s/${uuid}`)).text();
  expect(html).toContain("attach-here");
  expect(html).toContain('id="msgForm"');
  // VOS-212: placeholder-only body → iframe omitted (chat-first view, no phantom spinner)
  expect(html).not.toContain(`src="/s/${uuid}/body"`);
});

test("GET /s/:uuid with real body content includes iframe + attach + message affordances", async () => {
  const uuid = `vos-210-real-body-${Date.now()}`;
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "body.html"), "<!doctype html><title>Results</title><body><h1>done</h1></body></html>");
  const html = await (await makeApp(vault, db).request(`/s/${uuid}`)).text();
  // Both iframe and chat affordances present (precedence: show both)
  expect(html).toContain(`src="/s/${uuid}/body"`);
  expect(html).toContain("attach-here");
  expect(html).toContain('id="msgForm"');
});

// Restore mock.module registrations so sibling test files (e.g. spawn.test.ts) that import
// ../src/spawn.ts directly get the real implementation, not this file's stubs.
afterAll(() => {
  mock.restore();
});
