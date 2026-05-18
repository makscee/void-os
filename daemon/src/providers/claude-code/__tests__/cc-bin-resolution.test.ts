// VOS-134: cover env-var override + pre-flight check for the CC wrapper path.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CC_BIN_ENV_VAR,
  DEFAULT_CC_BIN,
  checkCcBinAvailable,
  findOnPath,
  resolveCcBin,
} from "../index";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vos-134-cc-bin-"));
}

function makeFakeBin(name = "claudev"): { dir: string; path: string } {
  const dir = makeTmpDir();
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("resolveCcBin", () => {
  it("returns the explicit override when provided", () => {
    expect(resolveCcBin("/custom/cc", { [CC_BIN_ENV_VAR]: "/from-env/cc" })).toBe(
      "/custom/cc",
    );
  });

  it("uses VOID_OS_CC_BIN when set and no explicit override", () => {
    expect(resolveCcBin(undefined, { [CC_BIN_ENV_VAR]: "/env/path/cc" })).toBe(
      "/env/path/cc",
    );
  });

  it("falls back to 'claudev' when env unset", () => {
    expect(resolveCcBin(undefined, {})).toBe(DEFAULT_CC_BIN);
  });

  it("ignores empty-string env var (treated as unset)", () => {
    expect(resolveCcBin(undefined, { [CC_BIN_ENV_VAR]: "" })).toBe(DEFAULT_CC_BIN);
  });
});

describe("findOnPath", () => {
  it("locates a bare-name binary across PATH entries", () => {
    const { dir, path } = makeFakeBin("claudev");
    const found = findOnPath("claudev", { PATH: `/nonexistent:${dir}` });
    expect(found).toBe(path);
  });

  it("returns null when binary is absent from every PATH dir", () => {
    expect(findOnPath("claudev", { PATH: "/nonexistent:/also-not-real" })).toBeNull();
  });

  it("returns null when PATH is unset", () => {
    expect(findOnPath("claudev", {})).toBeNull();
  });

  it("treats an absolute path as the target itself (no PATH walk)", () => {
    const { path } = makeFakeBin("claudev");
    // PATH irrelevant — absolute target either exists or it doesn't.
    expect(findOnPath(path, { PATH: "/nonexistent" })).toBe(path);
    expect(findOnPath("/abs/missing/claudev", { PATH: "/nonexistent" })).toBeNull();
  });
});

describe("checkCcBinAvailable", () => {
  it("ok=true when claudev is on PATH and env unset", () => {
    const { dir } = makeFakeBin("claudev");
    const result = checkCcBinAvailable({ env: { PATH: dir } });
    expect(result.ok).toBe(true);
    expect(result.binary).toBe("claudev");
    expect(result.resolvedPath).toBe(join(dir, "claudev"));
  });

  it("ok=true when VOID_OS_CC_BIN points at an existing file (PATH irrelevant)", () => {
    const { path } = makeFakeBin("claudev");
    const result = checkCcBinAvailable({
      env: { [CC_BIN_ENV_VAR]: path, PATH: "/nonexistent" },
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path);
  });

  it("ok=false with actionable message when neither env nor PATH resolves", () => {
    const result = checkCcBinAvailable({ env: { PATH: "/nonexistent" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(CC_BIN_ENV_VAR);
    expect(result.reason).toContain("PATH");
    expect(result.reason).toContain("void-os daemon start");
  });

  it("ok=false with absolute-path-not-found message when env points at missing file", () => {
    const result = checkCcBinAvailable({
      env: { [CC_BIN_ENV_VAR]: "/abs/missing/claudev", PATH: "/nonexistent" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("/abs/missing/claudev");
    expect(result.reason).toContain(CC_BIN_ENV_VAR);
  });

  // VOS-134 I2: when PATH is unset, the preview previously rendered as a
  // useless lone "." (env.PATH ?? "" coerced to falsy in template). The
  // message should say "<unset>" so the operator knows to set PATH itself.
  it("renders empty PATH as '<unset>' in the failure reason", () => {
    const result = checkCcBinAvailable({ env: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Current PATH: <unset>");
    expect(result.reason).not.toMatch(/Current PATH: \.\s/);
  });
});
