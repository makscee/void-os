import { describe, expect, it } from "bun:test";
import { runBootDenyProbe } from "../boot-probe";

describe("runBootDenyProbe", () => {
  it("resolves ok when hook denies", async () => {
    const result = await runBootDenyProbe({
      spawnFn: () => ({
        pid: 1,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              JSON.stringify({ continue: false, stopReason: "WRITE_SCOPE_DENIED: x" }),
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        stdin: { write: () => {}, end: () => {} } as never,
        kill: () => {},
      }) as never,
      hookScriptPath: "/fake/hook.ts",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when hook returns continue:true (fail-open)", async () => {
    const result = await runBootDenyProbe({
      spawnFn: () => ({
        pid: 1,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ continue: true })));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        stdin: { write: () => {}, end: () => {} } as never,
        kill: () => {},
      }) as never,
      hookScriptPath: "/fake/hook.ts",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fail-open|continue.*true/i);
  });
});
