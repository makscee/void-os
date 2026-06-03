import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pidPath, sessionDir, bodyPath, errorPath, stopPath } from "../src/paths.ts";
import { openRegistry, getExecution } from "../src/registry.ts";
import { killSession } from "../src/tmux.ts";

// Use a query-string specifier to bypass any mock.module("../src/spawn.ts", ...)
// registration from server.test.ts. Bun 1.3.14 matches mock.module paths by exact
// specifier, so adding ?real loads the actual source even without --isolate.
const {
  buildLaunchArgv, buildAnswerArgv, readCcSessionId, tokenizeCommand,
  spawnTurn, runTurn, spawnRun, buildInteractiveArgv, buildWrapperCommand,
} = await import("../src/spawn.ts?real");

test("buildLaunchArgv has no leading -- (separator now lives in runner command)", () => {
  const a = buildLaunchArgv("uuid-1", "deep-research", "hello");
  expect(a[0]).toBe("--session-id");
  expect(a).not.toContain("--");
  expect(a).toEqual(["--session-id", "uuid-1", "-p", "/deep-research hello", "--permission-mode", "bypassPermissions"]);
});

test("launch argv with no text omits trailing space", () => {
  const argv = buildLaunchArgv("u1", "onboarding", "");
  expect(argv[0]).toBe("--session-id");
  expect(argv[3]).toBe("/onboarding");
  expect(argv[3]).not.toContain(" ");
});

test("buildAnswerArgv has no leading --", () => {
  const a = buildAnswerArgv("uuid-1", "echo: hi");
  expect(a[0]).toBe("--resume");
  expect(a).not.toContain("--");
});

test("answer argv: resume + render-contract preamble before text", () => {
  const a = buildAnswerArgv("u1", "use option B");
  expect(a.slice(0, 2)).toEqual(["--resume", "u1"]);
  expect(a[3]).toBe("[render contract: rewrite body.html, no terminal reply]\nuse option B");
});

test("answer argv has correct shape: --resume uuid -p <preamble+text> --permission-mode bypassPermissions", () => {
  const a = buildAnswerArgv("my-uuid", "hello");
  expect(a).toHaveLength(6);
  expect(a[0]).toBe("--resume");
  expect(a[1]).toBe("my-uuid");
  expect(a[2]).toBe("-p");
  expect(a[4]).toBe("--permission-mode");
  expect(a[5]).toBe("bypassPermissions");
});

test("answer argv from form fields: key: value lines", () => {
  const fields = { name: "Alice", goal: "learn TypeScript" };
  const prompt = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const a = buildAnswerArgv("sess-1", prompt);
  expect(a[3]).toContain("name: Alice");
  expect(a[3]).toContain("goal: learn TypeScript");
});

// VOS-203: readCcSessionId reads the ACTUAL CC session ID from cc-actual-session.txt.
// Claude ignores --session-id for its file name; the hooks-endpoint writes the real ID
// from the SessionStart hook payload to cc-actual-session.txt.
test("readCcSessionId reads actual session ID from cc-actual-session.txt (primary source)", () => {
  const vault = "/tmp/void-os-spawn-ccsess-actual-test";
  const execId = "exec-test-actual-cc";
  const actualSessionId = "bc32d01a-76c0-4047-a876-5326c5f71895";
  const dir = join(vault, "sessions", execId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cc-actual-session.txt"), actualSessionId);
  expect(readCcSessionId(vault, execId)).toBe(actualSessionId);
  rmSync(vault, { recursive: true });
});

test("readCcSessionId falls back to cc-command.txt --session-id when cc-actual-session.txt absent", () => {
  const vault = "/tmp/void-os-spawn-ccsess-fallback-test";
  const execId = "exec-test-fallback-cc";
  const hintId = "34a64638-8625-4930-9377-51ca49490ac1";
  const dir = join(vault, "sessions", execId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cc-command.txt"),
    `claude -- --session-id ${hintId} --settings /tmp/x.json --permission-mode bypassPermissions /onboarding\n`);
  expect(readCcSessionId(vault, execId)).toBe(hintId);
  rmSync(vault, { recursive: true });
});

test("readCcSessionId returns null when neither cc-actual-session.txt nor cc-command.txt is present", () => {
  const vault = "/tmp/void-os-spawn-ccsess-absent-test";
  const execId = "exec-absent-cc-v2";
  mkdirSync(join(vault, "sessions", execId), { recursive: true });
  expect(readCcSessionId(vault, execId)).toBeNull();
  rmSync(vault, { recursive: true });
});

test("tokenizeCommand splits prefix into argv head", () => {
  expect(tokenizeCommand("vc --")).toEqual(["vc", "--"]);
  expect(tokenizeCommand("claude_artem")).toEqual(["claude_artem"]);
  expect(tokenizeCommand("  vc   -- ")).toEqual(["vc", "--"]);
});

test("spawnTurn persists the child pid to vc.pid", async () => {
  const vault = "/tmp/void-os-spawn-pid-test";
  const uuid = "pid-uuid-1";
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  // Use 'sleep 2' so the child stays alive long enough to observe the pid file
  spawnTurn(vault, uuid, ["2"], "sleep");
  const p = pidPath(vault, uuid);
  expect(existsSync(p)).toBe(true);
  expect(parseInt(readFileSync(p, "utf8"), 10)).toBeGreaterThan(0);
  // cleanup
  try { const pid = parseInt(readFileSync(p, "utf8"), 10); process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
});

test("spawnTurn child is its own process-group leader (pgid == pid)", async () => {
  const vault = "/tmp/void-os-spawn-pg-test";
  const uuid = "pg-uuid-1";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  spawnTurn(vault, uuid, ["2"], "sleep");
  await new Promise((r) => setTimeout(r, 150));
  const p = pidPath(vault, uuid);
  const pid = parseInt(readFileSync(p, "utf8"), 10);
  const pgidOut = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)]).stdout.toString().trim();
  expect(pgidOut).toBe(String(pid));
  // cleanup
  try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
});

test("runTurn persists then clears vc.pid", async () => {
  const vault = "/tmp/void-os-runturn-pid-test";
  const uuid = "rt-uuid-1";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  const p = runTurn(vault, vault, uuid, ["0.3"], "sleep");
  await new Promise((r) => setTimeout(r, 100));
  expect(existsSync(pidPath(vault, uuid))).toBe(true); // alive → pid present
  await p;
  expect(existsSync(pidPath(vault, uuid))).toBe(false); // exited → pid cleared
});

test("spawnTurn exit handler is a no-op once stopped.txt is present (race guard)", async () => {
  const vault = "/tmp/void-os-raceguard-test";
  const uuid = "race-uuid-1";
  rmSync(sessionDir(vault, uuid), { recursive: true, force: true });
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<p>placeholder</p>");
  spawnTurn(vault, uuid, ["-c", "exit 0"], "sh");
  writeFileSync(stopPath(vault, uuid), "stopped\n");
  await new Promise((r) => setTimeout(r, 400));
  expect(existsSync(errorPath(vault, uuid))).toBe(false);
});

// --- executions model: spawnRun creates an execution row + start event, never resumes ---

test("spawnRun creates an execution row with trigger_id + step_ceiling", () => {
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-spawn-exec-test";
  mkdirSync(vault, { recursive: true });
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: null, agent: "default",
    runnerCommand: "sleep",
    now: Date.now(),
    triggerId: "morning",
    stepCeiling: 7,
  });
  const e = getExecution(db, runId)!;
  expect(e.trigger_id).toBe("morning");
  expect(e.step_ceiling).toBe(7);
  expect(e.ended_at).toBeNull(); // not yet ended
  // cleanup
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

test("spawnRun argv uses --session-id (never --resume)", () => {
  // spawnRun is stateless: always fresh session. Verify this by checking the
  // event log start event (which only has 'start' type, not a resume marker).
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-spawn-stateless-test";
  mkdirSync(vault, { recursive: true });
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "smoke", agent: null,
    runnerCommand: "sleep",
    now: 1000,
  });
  // Check start event written
  const startEvent = readFileSync(join(vault, ".void-os", "events", `${runId}.jsonl`), "utf8");
  expect(startEvent).toContain('"type":"start"');
  expect(startEvent).not.toContain('"type":"resume"');
  // cleanup
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

test("spawnRun id prefixed exec- (stateless naming)", () => {
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-spawn-prefix-test";
  mkdirSync(vault, { recursive: true });
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: null, agent: null,
    runnerCommand: "sleep",
    now: 1000,
  });
  expect(runId.startsWith("exec-")).toBe(true);
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

// VOS-205 T2: buildInteractiveArgv
test("buildInteractiveArgv: interactive shape — no -p, fresh session id, vault add-dir, bypass perms", () => {
  const argv = buildInteractiveArgv("seed-uuid", "/vault", { addDirs: [] });
  expect(argv).toEqual([
    "--session-id", "seed-uuid",
    "--add-dir", "/vault",
    "--permission-mode", "bypassPermissions",
  ]);
  expect(argv).not.toContain("-p"); // interactive: skill arrives via send-keys, not -p
});

test("buildInteractiveArgv: extra addDirs are appended", () => {
  const argv = buildInteractiveArgv("seed-uuid", "/vault", { addDirs: ["/extra1", "/extra2"] });
  expect(argv).toContain("--add-dir");
  expect(argv).toContain("/extra1");
  expect(argv).toContain("/extra2");
});

test("buildWrapperCommand includes mode token as third positional arg", () => {
  const cmd = buildWrapperCommand("/path/to/wrapper.sh", "http://127.0.0.1:4317", "run-123", "interactive", "vc --raw");
  expect(cmd).toContain('"interactive"');
  expect(cmd).toContain('"http://127.0.0.1:4317"');
  expect(cmd).toContain('"run-123"');
  expect(cmd).toContain("vc --raw");
});

test("buildWrapperCommand print mode uses print token", () => {
  const cmd = buildWrapperCommand("/path/to/wrapper.sh", "http://127.0.0.1:4317", "run-456", "print", "vc --");
  expect(cmd).toContain('"print"');
});

test("spawnRun writes declared outputTarget into start event", () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const db = openRegistry(":memory:");
  const vault = mkdtempSync(join(tmpdir(), "vos-spawn-ot-"));
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "smoke", agent: null,
    runnerCommand: "sleep",
    now: 1000,
    outputTarget: "out/report.html",
  });
  const startEvent = JSON.parse(
    readFileSync(join(vault, ".void-os", "events", `${runId}.jsonl`), "utf8").split("\n")[0],
  );
  expect(startEvent.output_target).toBe("out/report.html");
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

// VOS-206 regression: interactive spawn must include --settings in argv so
// the SessionStart hook fires and writes cc-actual-session.txt.
// Without --settings, hooks are not configured → SessionStart never fires →
// cc-actual-session.txt never written → --resume on reap/respawn is broken.
test("buildInteractiveArgv includes --settings when settingsPath is provided", () => {
  const argv = buildInteractiveArgv("cc-seed-123", "/vault", {
    settingsPath: "/vault/.void-os/hook-settings/exec-abc.json",
  });
  expect(argv).toContain("--settings");
  expect(argv).toContain("/vault/.void-os/hook-settings/exec-abc.json");
  expect(argv).toContain("--session-id");
  expect(argv).toContain("cc-seed-123");
});

test("buildInteractiveArgv omits --settings when settingsPath is absent", () => {
  const argv = buildInteractiveArgv("cc-seed-456", "/vault", {});
  expect(argv).not.toContain("--settings");
});

test("spawnRun interactive path writes start event (cc-actual write path wired)", () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const db = openRegistry(":memory:");
  const vault = mkdtempSync(join(tmpdir(), "vos-spawn-interactive-"));
  // spawnRun with interactive:true should still write the start event via appendEvent.
  // This confirms the event-write path is not gated on the print/interactive branch.
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "chat", agent: null,
    runnerCommand: "sleep",
    now: 2000,
    interactive: true,
    outputTarget: null,
  });
  const startEvent = JSON.parse(
    readFileSync(join(vault, ".void-os", "events", `${runId}.jsonl`), "utf8").split("\n")[0],
  );
  expect(startEvent.type).toBe("start");
  expect(startEvent.skill).toBe("chat");
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

// VOS-206 Gap 2: interactive launch must register an executions row immediately.
// The proof showed exec-count=0 before the send (the proof was querying the wrong DB path,
// but the assertion that createExecution is called for interactive sessions is still load-bearing).
test("spawnRun interactive launch registers an executions row", () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const db = openRegistry(":memory:");
  const vault = mkdtempSync(join(tmpdir(), "vos-spawn-exec-row-"));
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "onboarding", agent: null,
    runnerCommand: "sleep",
    now: Date.now(),
    interactive: true,
    outputTarget: null,
  });
  const exec = getExecution(db, runId);
  expect(exec).not.toBeNull();
  expect(exec!.id).toBe(runId);
  expect(exec!.skill).toBe("onboarding");
  expect(exec!.ended_at).toBeNull(); // not ended yet
  try { killSession(tmuxSession); } catch { /* ignore */ }
});

// VOS-206 Gap 3: interactive launch argv must carry --raw before -- so vc opens the REPL
// instead of its bubbletea TUI menu. The fixed 3s setTimeout fired before claude was ready;
// --raw ensures vc opens the REPL immediately on launch.
test("spawnRun interactive argv carries --raw before -- in cc-command.txt", () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const db = openRegistry(":memory:");
  const vault = mkdtempSync(join(tmpdir(), "vos-spawn-raw-flag-"));
  const { runId, tmuxSession } = spawnRun({
    db, vault, daemonUrl: "http://127.0.0.1:4317",
    skill: "chat", agent: null,
    runnerCommand: "vc --",  // runner without --raw — spawnRun must inject it
    now: Date.now(),
    interactive: true,
    outputTarget: null,
  });
  const ccCmdPath = join(sessionDir(vault, runId), "cc-command.txt");
  const ccCmd = readFileSync(ccCmdPath, "utf8");
  // Assert: --raw appears before --
  const rawIdx = ccCmd.indexOf("--raw");
  const sepIdx = ccCmd.indexOf("--");
  expect(rawIdx).toBeGreaterThanOrEqual(0);   // --raw is present
  expect(rawIdx).toBeLessThan(sepIdx + 1);     // --raw comes before -- (rawIdx < sepIdx is the real check, but sepIdx finds "--raw" too)
  // More precise: the token sequence "vc --raw --" must appear
  expect(ccCmd).toMatch(/vc\s+--raw\s+--/);
  try { killSession(tmuxSession); } catch { /* ignore */ }
});
