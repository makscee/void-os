// VOS-73 T6: end-to-end integration tests against the fake-claudev fixture.
// Exercises real Bun.spawn — no mocking. Covers acceptance trail:
// spawn -> emit -> resume -> second emit (asserts --resume <sessionId>
// propagation via the fake's stderr echo), output-timeout kill, crash.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";
import { createEventBus, type DaemonEvent } from "../src/events/index.js";
import {
  createCcSpawner,
  NoSessionError,
} from "../src/providers/claude-code/index.js";
import { readTrace } from "../src/trace/reader.js";

const FAKE = resolve(import.meta.dir, "fixtures/fake-claudev");

// VOS-106 T7: createCcSpawner now requires engine/daemonBase/hookScriptPath/
// loadAgentDefn. Integration tests use --binary FAKE and never reach the
// scope-enforced spawn path, so we inject permissive stubs to satisfy the
// type and bypass real resolution. The fake fixture doesn't honour
// `--settings`/`--mcp-config` flags meaningfully — these stubs only need
// to keep buildSpawnSettings happy.
const stubDeps = () => ({
  engine: {
    resolveScopes: () => ({ readPaths: ["/tmp/**"], writePaths: ["/tmp/**"] }),
    canRead: () => true,
    canWrite: () => true,
    // VOS-106 T11.3: spawner reads engine.vaultRoot/homeRoot to expand
    // SYSTEM_DENY via the shared `resolveSystemDeny` helper. Stubbed roots
    // must be absolute so picomatch sees a valid prefix; values are
    // irrelevant since the fake binary never enforces the hook.
    vaultRoot: "/tmp",
    homeRoot: "/tmp",
  } as never,
  daemonBase: "http://127.0.0.1:17777",
  hookScriptPath: "/dev/null",
  loadAgentDefn: (name: string) => ({ name }),
});

// VOS-83: EventBus persistence was removed (legacy `events` table dropped in
// migration 0007). Tests now capture via in-memory subscribe instead of
// bus.query against SQLite.
interface EventQueryFilter { runId?: string; type?: string }
type Captured = (filter?: EventQueryFilter) => DaemonEvent[];

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "void-os-cc-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  const tracesDir = join(dir, "traces");
  const bus = createEventBus({ db });
  const captured: DaemonEvent[] = [];
  bus.subscribe("*", (e) => { captured.push(e); });
  const events: Captured = (filter = {}) =>
    captured.filter((e) =>
      (filter.runId === undefined || e.runId === filter.runId) &&
      (filter.type  === undefined || e.type  === filter.type),
    );
  return { dir, db, bus, tracesDir, events };
};

const teardown = (dir: string, db: { close: () => void }) => {
  try { db.close(); } catch { /* idempotent */ }
  rmSync(dir, { recursive: true, force: true });
};

describe("CC spawner (fake claudev)", () => {
  test("happy scenario: session captured, run.end with exit 0, runs row final", async () => {
    const { dir, db, bus, tracesDir, events: capturedEvents } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
    let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      proc = await spawner.spawn({
        prompt: "--scenario happy",
        agent: "test",
        cwd: dir,
      });

      const sessionId = await proc.sessionId();
      expect(sessionId).toMatch(/^sess-happy-/);

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBe("exited");
      expect(result.sessionId).toBe(sessionId);

      const row = db.prepare(
        "SELECT status, session_id, exit_code FROM runs WHERE id=?",
      ).get(proc.runId) as { status: string; session_id: string; exit_code: number };
      expect(row.status).toBe("done");
      expect(row.session_id).toBe(sessionId);
      expect(row.exit_code).toBe(0);

      const events = capturedEvents({ runId: proc.runId });
      const types = events.map((e) => e.type);
      expect(types).toContain("run.start");
      expect(types).toContain("run.session");
      expect(types).toContain("run.end");
      expect(types.filter((t) => t === "cc.event").length).toBeGreaterThan(0);

      // VOS-84 T19: assert trace envelope shape — turn.start first, turn.end
      // last. Sourced from the same row the daemon writes (trace_path).
      const traceRow = db.prepare(
        "SELECT trace_path FROM runs WHERE id=?",
      ).get(proc.runId) as { trace_path: string };
      const { records } = readTrace(traceRow.trace_path);
      const kinds = records.map((r) => r.kind);
      expect(kinds[0]).toBe("turn.start");
      expect(kinds[kinds.length - 1]!).toBe("turn.end");
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("tool-call scenario: trace records tool.call/tool.result pair with matching toolUseId", async () => {
    const { dir, db, bus, tracesDir, events: _capturedEvents } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
    let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      proc = await spawner.spawn({
        prompt: "--scenario tool-call",
        agent: "test",
        cwd: dir,
      });
      const result = await proc.wait();
      expect(result.exitCode).toBe(0);

      const traceRow = db.prepare(
        "SELECT trace_path FROM runs WHERE id=?",
      ).get(proc.runId) as { trace_path: string };
      const { records } = readTrace(traceRow.trace_path);
      const kinds = records.map((r) => r.kind);
      expect(kinds[0]).toBe("turn.start");
      expect(kinds[kinds.length - 1]!).toBe("turn.end");

      const toolCalls = records.filter((r) => r.kind === "tool.call");
      const toolResults = records.filter((r) => r.kind === "tool.result");
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolResults.length).toBeGreaterThan(0);
      const callIds = new Set(
        toolCalls.map((r) => (r.payload as { toolUseId: string }).toolUseId),
      );
      for (const tr of toolResults) {
        expect(callIds.has((tr.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("silent scenario: watchdog fires within 1500ms with watchdogTickMs:50", async () => {
    const { dir, db, bus, tracesDir, events: capturedEvents } = setup();
    const spawner = createCcSpawner({
      bus, db, tracesDir, binary: FAKE,
      watchdogTickMs: 50,
      ...stubDeps(),
    });
    let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      const t0 = Date.now();
      proc = await spawner.spawn({
        prompt: "--scenario silent",
        agent: "test",
        cwd: dir,
        outputTimeoutMs: 500,
      });
      const result = await proc.wait();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1500);
      expect(result.reason).toBe("timeout");

      const row = db.prepare(
        "SELECT status, kill_reason FROM runs WHERE id=?",
      ).get(proc.runId) as { status: string; kill_reason: string };
      expect(row.status).toBe("error");        // mapped from reason="timeout"
      expect(row.kill_reason).toBe("timeout"); // granularity preserved

      const events = capturedEvents({ runId: proc.runId, type: "run.timeout" });
      expect(events).toHaveLength(1);
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("crash scenario: cc.stderr emitted, non-zero exit, sessionId() rejects, stderr ts <= run.end ts", async () => {
    const { dir, db, bus, tracesDir, events: capturedEvents } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
    let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      proc = await spawner.spawn({
        prompt: "--scenario crash",
        agent: "test",
        cwd: dir,
      });
      const result = await proc.wait();
      expect(result.exitCode).not.toBe(0);

      // sessionId() must reject only AFTER wait() resolves — finalize tail
      // is the sole source of the rejection.
      await expect(proc.sessionId()).rejects.toBeInstanceOf(NoSessionError);

      const stderr = capturedEvents({ runId: proc.runId, type: "cc.stderr" });
      expect(stderr.length).toBeGreaterThan(0);

      // Ordering: every cc.stderr ts must be <= run.end ts. This proves
      // finalize awaited stderrDone before emitting run.end.
      const endEvents = capturedEvents({ runId: proc.runId, type: "run.end" });
      expect(endEvents).toHaveLength(1);
      const endTs = endEvents[0].ts ?? 0;
      expect(stderr.every((e) => (e.ts ?? 0) <= endTs)).toBe(true);
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("resume: --resume <id> reaches fake; second run echoes resume id", async () => {
    const { dir, db, bus, tracesDir, events: capturedEvents } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
    let first: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    let second: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      first = await spawner.spawn({
        prompt: "--scenario happy",
        agent: "test",
        cwd: dir,
      });
      const sid = await first.sessionId();
      await first.wait();

      second = await spawner.spawn({
        prompt: "--scenario resume",
        agent: "test",
        cwd: dir,
        resumeFrom: sid,
      });
      const sid2 = await second.sessionId();
      expect(sid2).toBe(sid);             // fake echoes resume id back as session_id

      const result = await second.wait();
      expect(result.exitCode).toBe(0);

      // stderr should contain "fake-claudev resume: <sid>" — proves the
      // spawner forwarded --resume <sid> to the child argv.
      const stderr = capturedEvents({ runId: second.runId, type: "cc.stderr" });
      const allChunks = stderr
        .map((e) => (e.payload as { chunk: string }).chunk)
        .join("");
      expect(allChunks).toContain(`fake-claudev resume: ${sid}`);
      expect(allChunks).toContain("--resume");
    } finally {
      if (first)  { try { await first.kill();  } catch { /* already dead */ } }
      if (second) { try { await second.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  // VOS-80: fast-cancel must terminate the subprocess quickly. With the
  // default SIGTERM-5s-SIGKILL path, a CC subprocess that traps SIGTERM
  // can keep streaming for up to 5s — defeating user cancel. The
  // `{fast: true}` mode sends SIGINT with a 250ms SIGKILL grace, which
  // even a SIGTERM-trapping CC cannot stall.
  test("kill({fast: true}) terminates a parked subprocess within ~1s", async () => {
    const { dir, db, bus, tracesDir, events: capturedEvents } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE, ...stubDeps() });
    let proc: Awaited<ReturnType<typeof spawner.spawn>> | undefined;
    try {
      // `silent` scenario parks on `exec sleep 60`. Without a kill it
      // would never exit within the test timeout.
      proc = await spawner.spawn({
        prompt: "--scenario silent",
        agent: "test",
        cwd: dir,
      });
      await proc.sessionId(); // ensure spawn fully wired

      const t0 = Date.now();
      await proc.kill({ fast: true });
      const elapsed = Date.now() - t0;

      // Hard upper bound: well under the default 5s SIGTERM grace. SIGINT
      // alone should kill `sleep` immediately; even worst-case 250ms grace
      // + SIGKILL escalation keeps us under 1s.
      expect(elapsed).toBeLessThan(1000);

      const row = db.prepare(
        "SELECT status, kill_reason FROM runs WHERE id=?",
      ).get(proc.runId) as { status: string; kill_reason: string };
      expect(row.status).toBe("cancelled");
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });
});
