import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, BinaryNotFoundError } from "../src/daemon-lifecycle";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vos-bin-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeExe(path: string): void {
  writeFileSync(path, "#!/bin/sh\necho /resolved\n");
  chmodSync(path, 0o755);
}

describe("resolveBinary", () => {
  it("returns settings.voidOsBinaryPath when set and executable", async () => {
    const p = join(dir, "void-os");
    makeExe(p);
    const got = await resolveBinary(
      { voidOsBinaryPath: p },
      { home: dir, pathDirs: [] },
    );
    expect(got).toBe(p);
  });

  it("returns cached resolvedBinaryPath when valid", async () => {
    const p = join(dir, "void-os");
    makeExe(p);
    const got = await resolveBinary(
      { resolvedBinaryPath: p },
      { home: dir, pathDirs: [] },
    );
    expect(got).toBe(p);
  });

  it("falls through to well-known dirs when override+cache miss", async () => {
    const bunBin = join(dir, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const p = join(bunBin, "void-os");
    makeExe(p);
    const got = await resolveBinary({}, { home: dir, pathDirs: [] });
    expect(got).toBe(p);
  });

  it("throws BinaryNotFoundError when nothing resolves", async () => {
    await expect(
      resolveBinary({}, { home: dir, pathDirs: [] }),
    ).rejects.toThrow(BinaryNotFoundError);
  });
});
