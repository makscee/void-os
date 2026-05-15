import { describe, it, expect } from "bun:test";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";

describe("PendingRegistry", () => {
  it("resolves a registered awaiter with the posted answer", async () => {
    const reg = createPendingRegistry();
    const p = reg.register("tu-1", 1000);
    expect(reg.size()).toBe(1);
    queueMicrotask(() => reg.resolve("tu-1", "yes"));
    const answer = await p;
    expect(answer).toBe("yes");
    expect(reg.size()).toBe(0);
  });

  it("second resolve for the same tool_use_id is a no-op", () => {
    const reg = createPendingRegistry();
    const p = reg.register("tu-1", 1000);
    void p.catch(() => {}); // suppress unhandled
    expect(reg.resolve("tu-1", "yes")).toBe(true);
    expect(reg.resolve("tu-1", "no")).toBe(false);
  });

  it("rejects with ASK_USER_TIMEOUT after deadline", async () => {
    const reg = createPendingRegistry();
    const p = reg.register("tu-1", 20);
    await expect(p).rejects.toThrow("ASK_USER_TIMEOUT");
    expect(reg.size()).toBe(0);
  });

  it("resolve after timeout fired is a no-op", async () => {
    const reg = createPendingRegistry();
    const p = reg.register("tu-1", 20);
    void p.catch(() => {});
    await new Promise((r) => setTimeout(r, 40));
    expect(reg.resolve("tu-1", "late")).toBe(false);
  });

  it("cancelAll rejects every pending awaiter with ASK_USER_CANCELLED", async () => {
    const reg = createPendingRegistry();
    const p1 = reg.register("tu-1", 60_000);
    const p2 = reg.register("tu-2", 60_000);
    reg.cancelAll();
    await expect(p1).rejects.toThrow("ASK_USER_CANCELLED");
    await expect(p2).rejects.toThrow("ASK_USER_CANCELLED");
    expect(reg.size()).toBe(0);
  });
});
