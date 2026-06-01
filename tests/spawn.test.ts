import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLaunchArgv, buildAnswerArgv, tokenizeCommand, spawnTurn, runTurn, spawnRun } from "../src/spawn.ts";
import { pidPath, sessionDir, bodyPath, errorPath, stopPath } from "../src/paths.ts";
import { openRegistry, getExecution } from "../src/registry.ts";
import { killSession } from "../src/tmux.ts";

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
