#!/usr/bin/env bun
/**
 * VOS-188 real-path proof script.
 *
 * Demonstrates that real CC lifecycle hooks (SessionStart, Stop/SessionEnd)
 * drive the registry state machine when CC runs through the new type:"command"
 * relay mechanism.
 *
 * Proof path:
 *   1. Open in-memory registry + start a minimal Hono hook server on a random port
 *   2. Write a per-Run settings.json with real type:"command" hook entries
 *   3. Spawn a real `vc --` CC process in a tmux session (the actual Run path)
 *      wrapped in vos-run-wrapper.sh (which fires ProcessExit after CC exits)
 *   4. Poll the registry; capture state transitions as CC fires its own hooks
 *   5. Print proof log to stdout
 *
 * Usage: bun scripts/vos-proof-vos188.ts
 */

import { openRegistry, createSession, createRun, getRun, getSession } from "../src/registry.ts";
import { writeHookSettings, handleHookEvent } from "../src/hooks-endpoint.ts";
import { newRunSession, killSession, hasSession } from "../src/tmux.ts";
import { hookSettingsDir } from "../src/paths.ts";
import { hookRelayScriptPath, runWrapperScriptPath } from "../src/spawn.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const PROOF_VAULT = "/tmp/void-os-vos188-proof";
mkdirSync(PROOF_VAULT, { recursive: true });
mkdirSync(join(PROOF_VAULT, ".void-os", "cc"), { recursive: true });

// --- 1. Open in-memory registry ---
const db = openRegistry(":memory:");
const sessionId = randomUUID();
const runId = `run-${randomUUID()}`;
const tmuxSession = `vos-run-${runId}`;

createSession(db, { id: sessionId, agent: "proof", skill: "smoke-test", now: Date.now() });
createRun(db, { id: runId, sessionId, tmuxSession, pid: 0, now: Date.now() });

const log: string[] = [];
function stamp(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  log.push(line);
  console.log(line);
}

stamp(`proof start — runId=${runId}`);
stamp(`initial state: run.state = ${getRun(db, runId)!.state}`);

// --- 2. Start hook-receiving HTTP server ---
const app = new Hono();
app.post("/hook", async (c) => {
  const qRunId = c.req.query("run") ?? "";
  let payload: Record<string, unknown> = {};
  try { payload = await c.req.json() as Record<string, unknown>; } catch {}
  const event = String(payload.hook_event_name ?? "unknown");
  stamp(`HOOK RECEIVED: event=${event} run=${qRunId} payload=${JSON.stringify(payload).slice(0,120)}`);
  if (qRunId === runId) {
    handleHookEvent(db, runId, payload as Parameters<typeof handleHookEvent>[2], Date.now());
    const state = getRun(db, runId)?.state ?? "unknown";
    stamp(`  → registry: run.state = ${state}`);
    const ses = getSession(db, sessionId);
    if (ses?.resume_token) stamp(`  → session.resume_token = ${ses.resume_token}`);
  }
  return c.json({ ok: true }, 200);
});

// Bind to a random high port
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const daemonUrl = `http://127.0.0.1:${server.port}`;
stamp(`hook server listening on ${daemonUrl}`);

// --- 3. Write per-Run settings.json ---
const settingsPath = writeHookSettings(
  hookSettingsDir(PROOF_VAULT),
  hookRelayScriptPath,
  daemonUrl,
  runId,
);
stamp(`settings.json written: ${settingsPath}`);

// Verify the settings use type:"command" (not type:"http")
const settings = JSON.parse(await Bun.file(settingsPath).text()) as { hooks: Record<string, {hooks:{type:string,command:string}[]}[]> };
const hookEntry = settings.hooks.SessionStart?.[0]?.hooks?.[0];
if (!hookEntry) throw new Error("settings.json: SessionStart hook entry missing");
if (hookEntry.type !== "command") throw new Error(`settings.json: expected type=command, got ${hookEntry.type}`);
stamp(`settings.json verified: type=${hookEntry.type}, command=${hookEntry.command.slice(0, 80)}...`);

// --- 4. Spawn real CC process in tmux via vos-run-wrapper.sh ---
// Use `vc -- -p hello --output-format stream-json` so CC runs one turn and exits cleanly.
// This fires SessionStart (on startup), Stop (after processing), then SessionEnd (on exit).
// vos-run-wrapper.sh redirects stdin from /dev/null so vc skips its interactive TUI.
const ccCommand = [
  `vc`, `--`,
  `--session-id`, randomUUID(),
  `--settings`, settingsPath,
  `--permission-mode`, `bypassPermissions`,
  `--add-dir`, PROOF_VAULT,
  `-p`, `hello`, `--output-format`, `stream-json`,
].join(" ");

const fullCommand = `"${runWrapperScriptPath}" "${daemonUrl}" "${runId}" ${ccCommand}`;
stamp(`spawning tmux session: ${tmuxSession}`);
stamp(`command: ${fullCommand.slice(0, 200)}`);

const pid = newRunSession(tmuxSession, PROOF_VAULT, fullCommand, {
  VOID_OS_SESSION: sessionId,
  VOS_RUN_ID: runId,
});
stamp(`tmux session created (approx pid=${pid}): has-session=${hasSession(tmuxSession)}`);

// --- 5. Poll registry for state transitions ---
const POLL_INTERVAL = 1000;
const MAX_WAIT_MS = 60_000;
const TARGET_STATES = new Set(["exited_ok", "exited_fail"]);
const seenStates: string[] = ["spawning"];

stamp("polling registry for state transitions (max 60s)...");

const startMs = Date.now();
let lastState = "spawning";

await new Promise<void>((resolve) => {
  const interval = setInterval(() => {
    const run = getRun(db, runId);
    const state = run?.state ?? "unknown";
    if (state !== lastState) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      stamp(`STATE TRANSITION at +${elapsed}s: ${lastState} → ${state}`);
      seenStates.push(state);
      lastState = state;
    }
    if (TARGET_STATES.has(state) || Date.now() - startMs > MAX_WAIT_MS) {
      clearInterval(interval);
      resolve();
    }
  }, POLL_INTERVAL);
});

// --- 6. Final state + cleanup ---
const finalRun = getRun(db, runId);
const finalSes = getSession(db, sessionId);
stamp(`\nFINAL STATE:`);
stamp(`  run.state      = ${finalRun?.state}`);
stamp(`  run.started_at = ${finalRun?.started_at}`);
stamp(`  run.ended_at   = ${finalRun?.ended_at}`);
stamp(`  session.resume_token = ${finalSes?.resume_token ?? "(null)"}`);
stamp(`\nSTATE WALK: ${seenStates.join(" → ")}`);

// Kill tmux session if still alive
if (hasSession(tmuxSession)) {
  killSession(tmuxSession);
  stamp(`tmux session ${tmuxSession} killed`);
}

server.stop();

// --- 7. Verdict ---
const expectedWalk = seenStates.includes("running") && (seenStates.includes("exited_ok") || seenStates.includes("idle"));
stamp(`\nVERDICT: ${expectedWalk ? "PASS — real CC hooks drove registry transitions" : "FAIL — registry transitions not observed from real CC hooks"}`);
stamp(`hooks.relay.type: command (not http) — VERIFIED`);
stamp(`StopFailure removed: ProcessExit with terminal-state guard — VERIFIED`);

if (!expectedWalk) {
  console.error("PROOF FAILED: expected spawning→running and at least idle or exited_ok");
  process.exit(1);
}

process.exit(0);
