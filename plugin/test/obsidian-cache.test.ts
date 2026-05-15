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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cacheIsValid } from "../e2e/obsidian-cache";

describe("cacheIsValid", () => {
  function mkScratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voscache-test-"));
    const versionFile = path.join(dir, "VERSION");
    const binPath = path.join(dir, "Obsidian.app", "Contents", "MacOS", "Obsidian");
    return { dir, versionFile, binPath };
  }

  test("returns false when VERSION missing", () => {
    const { versionFile, binPath } = mkScratch();
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
  });

  test("returns false when binary missing", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.writeFileSync(versionFile, "1.8.10\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns false on version mismatch", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "");
    fs.writeFileSync(versionFile, "1.8.9\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns true when VERSION matches and binary present", () => {
    const { dir, versionFile, binPath } = mkScratch();
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "");
    fs.writeFileSync(versionFile, "1.8.10\n");
    expect(cacheIsValid(versionFile, binPath, "1.8.10")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
