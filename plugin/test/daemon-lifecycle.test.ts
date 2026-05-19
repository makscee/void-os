import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBinary, BinaryNotFoundError, ensureDaemon, VaultMismatchError, resolveBunDir, resolveHome } from "../src/daemon-lifecycle";

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

describe("resolveHome (VOS-143)", () => {
  it("returns process.env.VOID_OS_HOME when set", () => {
    const prev = process.env.VOID_OS_HOME;
    try {
      process.env.VOID_OS_HOME = "/tmp/vos-smoke-home";
      expect(resolveHome()).toBe("/tmp/vos-smoke-home");
    } finally {
      if (prev === undefined) delete process.env.VOID_OS_HOME;
      else process.env.VOID_OS_HOME = prev;
    }
  });

  it("falls back to OS homedir() when VOID_OS_HOME is unset", () => {
    const prev = process.env.VOID_OS_HOME;
    try {
      delete process.env.VOID_OS_HOME;
      expect(resolveHome()).toBe(homedir());
    } finally {
      if (prev !== undefined) process.env.VOID_OS_HOME = prev;
    }
  });

  it("falls back to OS homedir() when VOID_OS_HOME is empty string", () => {
    const prev = process.env.VOID_OS_HOME;
    try {
      process.env.VOID_OS_HOME = "";
      expect(resolveHome()).toBe(homedir());
    } finally {
      if (prev === undefined) delete process.env.VOID_OS_HOME;
      else process.env.VOID_OS_HOME = prev;
    }
  });
});

describe("resolveBunDir (VOS-143)", () => {
  it("returns ~/.bun/bin when bun is executable there", () => {
    const bunBin = join(dir, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const p = join(bunBin, "bun");
    makeExe(p);
    const got = resolveBunDir({ home: dir, pathDirs: [] });
    expect(got).toBe(bunBin);
  });

  it("returns null when bun is not found in any well-known location", () => {
    // dir is empty. The well-known absolutes (/opt/homebrew/bin/bun,
    // /usr/local/bin/bun) may exist on a dev host. Skip the assertion when
    // they do — the contract is "well-known fallback works", which the
    // previous test already covers via $HOME-based discovery.
    const homebrewBun = "/opt/homebrew/bin/bun";
    const usrLocalBun = "/usr/local/bin/bun";
    let realBunPresent = false;
    try {
      if (statSync(homebrewBun).isFile()) realBunPresent = true;
    } catch {}
    try {
      if (statSync(usrLocalBun).isFile()) realBunPresent = true;
    } catch {}
    if (realBunPresent) return;
    const got = resolveBunDir({ home: dir, pathDirs: [] });
    expect(got).toBeNull();
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

  it("probes first: attaches without resolving binary when daemon is already up (T9-fix-B)", async () => {
    // No settings.voidOsBinaryPath, no cache, no well-known path — resolveBinary
    // would throw BinaryNotFoundError. Probe succeeds, so we must never reach it.
    const probe = async () => ({ ok: true, vault_root: "/V", version: "0.1", port: 7777 });
    const result = await ensureDaemon({
      vaultRoot: "/V",
      settings: {},
      probeHealth: probe,
      spawnCli: async () => { throw new Error("must not spawn"); },
    });
    expect(result.port).toBe(7777);
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
