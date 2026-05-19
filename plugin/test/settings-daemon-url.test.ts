import { describe, test, expect } from "bun:test";
import { makeSettingsStore, DEFAULT_SETTINGS } from "../src/chat/settings.ts";

describe("settings.daemonUrl", () => {
  test("default is undefined (caller falls back to localhost)", () => {
    expect(DEFAULT_SETTINGS.daemonUrl).toBeUndefined();
  });

  test("loaded value is preserved", async () => {
    const io = {
      loadData: async () => ({ daemonUrl: "http://127.0.0.1:17777" }),
      saveData: async () => {},
    };
    const store = await makeSettingsStore(io);
    expect(store.get().daemonUrl).toBe("http://127.0.0.1:17777");
  });

  test("setDaemonUrl('') normalises to undefined and persists undefined", async () => {
    const writes: Array<{ daemonUrl?: string }> = [];
    const store = await makeSettingsStore({
      loadData: async () => ({ daemonUrl: "http://127.0.0.1:17777" }),
      saveData: async (d) => { writes.push(d as { daemonUrl?: string }); },
    });
    await store.setDaemonUrl("");
    expect(store.get().daemonUrl).toBeUndefined();
    expect(writes.length).toBe(1);
    expect(writes[0].daemonUrl).toBeUndefined();
  });

  test("setDaemonUrl('   ') (whitespace-only) also normalises to undefined", async () => {
    const writes: Array<{ daemonUrl?: string }> = [];
    const store = await makeSettingsStore({
      loadData: async () => null,
      saveData: async (d) => { writes.push(d as { daemonUrl?: string }); },
    });
    await store.setDaemonUrl("   ");
    expect(store.get().daemonUrl).toBeUndefined();
    expect(writes[0].daemonUrl).toBeUndefined();
  });

  test("setDaemonUrl with a real URL persists it verbatim", async () => {
    const writes: Array<{ daemonUrl?: string }> = [];
    const store = await makeSettingsStore({
      loadData: async () => null,
      saveData: async (d) => { writes.push(d as { daemonUrl?: string }); },
    });
    await store.setDaemonUrl("http://127.0.0.1:7842");
    expect(store.get().daemonUrl).toBe("http://127.0.0.1:7842");
    expect(writes[0].daemonUrl).toBe("http://127.0.0.1:7842");
  });
});
