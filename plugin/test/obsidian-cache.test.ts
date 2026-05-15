// VOS-94 — obsidian-cache unit tests.
import { describe, test, expect } from "bun:test";
import { OBSIDIAN_VERSION, ensureObsidian } from "../e2e/obsidian-cache";

describe("ensureObsidian platform guard", () => {
  test("non-darwin throws clear error naming the follow-up", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(ensureObsidian()).rejects.toThrow(/macOS only.*Linux follow-up/i);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  test("exports a pinned version constant", () => {
    expect(OBSIDIAN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
