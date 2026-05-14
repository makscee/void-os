import { describe, test, expect } from "bun:test";
import { makeSettingsStore } from "../src/chat/settings";

describe("makeSettingsStore", () => {
  test("returns DEFAULT_SETTINGS when loadData yields null", async () => {
    const store = await makeSettingsStore({
      loadData: async () => null,
      saveData: async () => {},
    });
    expect(store.get().chatId).toBeNull();
  });

  test("merges persisted data over defaults", async () => {
    const store = await makeSettingsStore({
      loadData: async () => ({ chatId: "c-saved" }),
      saveData: async () => {},
    });
    expect(store.get().chatId).toBe("c-saved");
  });

  test("setChatId persists via saveData and updates the in-memory snapshot", async () => {
    const writes: unknown[] = [];
    const store = await makeSettingsStore({
      loadData: async () => null,
      saveData: async (d) => { writes.push(d); },
    });
    await store.setChatId("c-fresh");
    expect(store.get().chatId).toBe("c-fresh");
    expect(writes.length).toBe(1);
    expect((writes[0] as { chatId?: string }).chatId).toBe("c-fresh");
  });

  test("loadData rejection falls back to defaults without throwing", async () => {
    const store = await makeSettingsStore({
      loadData: async () => { throw new Error("nope"); },
      saveData: async () => {},
    });
    expect(store.get().chatId).toBeNull();
  });
});
