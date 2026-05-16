import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { makeFakeProvider } from "../index.ts";

function tmpJsonl(lines: string[]): string {
  const p = path.join(os.tmpdir(), `fake-provider-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

describe("makeFakeProvider", () => {
  test("name is 'fake'", () => {
    const p = makeFakeProvider({ scriptPath: tmpJsonl([]) });
    expect(p.name).toBe("fake");
  });

  test("emits events parsed from JSONL then resolves done", async () => {
    const scriptPath = tmpJsonl([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);
    const provider = makeFakeProvider({ scriptPath });
    const handle = provider.spawn({ runId: "r1", prompt: "p", cwd: "/tmp", taskId: "t1", contextId: "c1" });
    const seen: string[] = [];
    for await (const ev of handle.events) seen.push(ev.type);
    // VOS-96 T3: fake provider normalizes CC frames on yield per ADR-0001
    // §Decision (legacy system/assistant → canonical session/parts).
    expect(seen).toEqual(["session", "parts"]);
    const result = await handle.done;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("s1");
  });

  test("cancel ends iteration with reason=cancel", async () => {
    const scriptPath = tmpJsonl([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "assistant", message: {} }),
    ]);
    const provider = makeFakeProvider({ scriptPath, perEventDelayMs: 50 });
    const handle = provider.spawn({ runId: "r2", prompt: "p", cwd: "/tmp", taskId: "t2", contextId: "c2" });
    const it = handle.events[Symbol.asyncIterator]();
    await it.next(); // pull first
    const cancelled = await handle.cancel();
    expect(cancelled).toBe(true);
    while (!(await it.next()).done) {}
    const result = await handle.done;
    expect(result.reason).toBe("cancel");
  });

  test("cancel before first iteration resolves done with reason=cancel", async () => {
    const scriptPath = tmpJsonl([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    ]);
    const provider = makeFakeProvider({ scriptPath });
    const handle = provider.spawn({ runId: "r4", prompt: "p", cwd: "/tmp", taskId: "t4", contextId: "c4" });
    await handle.cancel();
    const result = await Promise.race([
      handle.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock: done did not resolve within 1s")), 1000)),
    ]);
    expect(result.reason).toBe("cancel");
  });

  test("empty script resolves done with reason=exit immediately", async () => {
    const scriptPath = tmpJsonl([]);
    const provider = makeFakeProvider({ scriptPath });
    const handle = provider.spawn({ runId: "r5", prompt: "p", cwd: "/tmp", taskId: "t5", contextId: "c5" });
    const seen: string[] = [];
    for await (const ev of handle.events) seen.push(ev.type);
    expect(seen).toEqual([]);
    const result = await handle.done;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(0);
  });

  test("missing script => done resolves reason=error", async () => {
    const provider = makeFakeProvider({ scriptPath: "/tmp/does-not-exist-vos93.jsonl" });
    const handle = provider.spawn({ runId: "r3", prompt: "p", cwd: "/tmp", taskId: "t3", contextId: "c3" });
    for await (const _ of handle.events) {}
    const result = await handle.done;
    expect(result.reason).toBe("error");
  });
});
