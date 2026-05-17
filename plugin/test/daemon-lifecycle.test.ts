import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, BinaryNotFoundError, ensureDaemon, VaultMismatchError } from "../src/daemon-lifecycle";

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

describe("ensureDaemon", () => {
  it("attaches when /health returns 200 with matching vault_root", async () => {
    const probe = async () => ({ ok: true, vault_root: "/V", version: "0.1", port: 7777 });
    const result = await ensureDaemon({
      vaultRoot: "/V",
      settings: { resolvedBinaryPath: "/bin/echo" },
      probeHealth: probe,
      spawnCli: async () => { throw new Error("must not spawn"); },
    });
    expect(result.port).toBe(7777);
    expect(result.vault_root).toBe("/V");
  });

  it("throws VaultMismatchError when /health returns a different vault_root", async () => {
    const probe = async () => ({ ok: true, vault_root: "/OTHER", version: "0.1", port: 7777 });
    await expect(ensureDaemon({
      vaultRoot: "/V",
      settings: { resolvedBinaryPath: "/bin/echo" },
      probeHealth: probe,
      spawnCli: async () => { throw new Error("must not spawn"); },
    })).rejects.toBeInstanceOf(VaultMismatchError);
  });

  it("spawns when probe rejects, then attaches after poll succeeds", async () => {
    let probeCalls = 0;
    const probe = async () => {
      probeCalls++;
      if (probeCalls < 3) throw new Error("ECONNREFUSED");
      return { ok: true, vault_root: "/V", version: "0.1", port: 7777 };
    };
    const spawnCalls: string[][] = [];
    const result = await ensureDaemon({
      vaultRoot: "/V",
      settings: { resolvedBinaryPath: "/bin/echo" },
      probeHealth: probe,
      spawnCli: async (bin, args) => { spawnCalls.push([bin, ...args]); },
      pollIntervalMs: 5,
      pollTimeoutMs: 500,
    });
    expect(result.vault_root).toBe("/V");
    expect(spawnCalls[0]).toEqual(["/bin/echo", "daemon", "start", "--vault", "/V"]);
  });
});
