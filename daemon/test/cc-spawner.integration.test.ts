// VOS-73 T6: end-to-end integration tests against the fake-claudev fixture.
// Exercises real Bun.spawn — no mocking. Covers acceptance trail:
// spawn -> emit -> resume -> second emit (asserts --resume <sessionId>
// propagation via the fake's stderr echo), output-timeout kill, crash.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";
import { createEventBus } from "../src/events/index.js";
import {
  createCcSpawner,
  NoSessionError,
} from "../src/adapters/cc/index.js";

const FAKE = resolve(import.meta.dir, "fixtures/fake-claudev");

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "void-os-cc-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  const tracesDir = join(dir, "traces");
  const bus = createEventBus({ db });
  return { dir, db, bus, tracesDir };
};

const teardown = (dir: string, db: { close: () => void }) => {
  try { db.close(); } catch { /* idempotent */ }
  rmSync(dir, { recursive: true, force: true });
};

describe("CC spawner (fake claudev)", () => {
  test("happy scenario: session captured, run.end with exit 0, runs row final", async () => {
    const { dir, db, bus, tracesDir } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE });
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

      const events = await bus.query({ runId: proc.runId });
      const types = events.map((e) => e.type);
      expect(types).toContain("run.start");
      expect(types).toContain("run.session");
      expect(types).toContain("run.end");
      expect(types.filter((t) => t === "cc.event").length).toBeGreaterThan(0);
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("silent scenario: watchdog fires within 1500ms with watchdogTickMs:50", async () => {
    const { dir, db, bus, tracesDir } = setup();
    const spawner = createCcSpawner({
      bus, db, tracesDir, binary: FAKE,
      watchdogTickMs: 50,
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

      const events = await bus.query({ runId: proc.runId, type: "run.timeout" });
      expect(events).toHaveLength(1);
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("crash scenario: cc.stderr emitted, non-zero exit, sessionId() rejects, stderr ts <= run.end ts", async () => {
    const { dir, db, bus, tracesDir } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE });
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

      const stderr = await bus.query({ runId: proc.runId, type: "cc.stderr" });
      expect(stderr.length).toBeGreaterThan(0);

      // Ordering: every cc.stderr ts must be <= run.end ts. This proves
      // finalize awaited stderrDone before emitting run.end.
      const endEvents = await bus.query({ runId: proc.runId, type: "run.end" });
      expect(endEvents).toHaveLength(1);
      const endTs = endEvents[0].ts ?? 0;
      expect(stderr.every((e) => (e.ts ?? 0) <= endTs)).toBe(true);
    } finally {
      if (proc) { try { await proc.kill(); } catch { /* already dead */ } }
      teardown(dir, db);
    }
  });

  test("resume: --resume <id> reaches fake; second run echoes resume id", async () => {
    const { dir, db, bus, tracesDir } = setup();
    const spawner = createCcSpawner({ bus, db, tracesDir, binary: FAKE });
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
      const stderr = await bus.query({ runId: second.runId, type: "cc.stderr" });
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
});
