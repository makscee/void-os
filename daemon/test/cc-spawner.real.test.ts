import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/index.js";
import { createEventBus, type DaemonEvent } from "../src/events/index.js";
import { createCcSpawner } from "../src/providers/claude-code/index.js";

const enabled = process.env.VOS_E2E_REAL === "1";

describe("CC spawner (real claudev)", () => {
  test.if(enabled)("emits session_id, assistant text contains OK, exit 0 under 60s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "void-os-real-"));
    try {
      const db = openDatabase(join(dir, "state.sqlite"));
      const bus = createEventBus({ db });
      const tracesDir = join(dir, "traces");

      const spawner = createCcSpawner({ bus, db, tracesDir });
      const events: DaemonEvent[] = [];
      const unsubscribe = bus.subscribe("cc.event", (e) => events.push(e));
      const t0 = Date.now();
      const proc = await spawner.spawn({
        prompt: "Reply with exactly OK and nothing else.",
        agent: "test",
        cwd: dir,
        taskId: "t-real",
        contextId: "c-real",
      });
      const sid = await proc.sessionId();
      expect(sid.length).toBeGreaterThan(0);

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(Date.now() - t0).toBeLessThan(60_000);

      unsubscribe();
      const matching = events.filter((e) => e.runId === proc.runId);
      const text = matching
        .map((e) => JSON.stringify((e.payload as { event: unknown }).event))
        .join(" ");
      expect(text).toContain("OK");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 75_000);

  test.if(!enabled)("skipped (set VOS_E2E_REAL=1 to enable)", () => {
    expect(true).toBe(true);
  });
});
