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
});
