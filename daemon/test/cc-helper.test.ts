import { describe, expect, test } from "bun:test";
import { probeClaudev } from "../src/providers/claude-code/index.js";

const hasClaudev = await (async () => {
  try {
    const which = Bun.spawn(["which", "claudev"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(which.stdout).text();
    const code = await which.exited;
    return code === 0 && out.trim().length > 0;
  } catch {
    return false;
  }
})();

describe("probeClaudev", () => {
  test.if(hasClaudev)("returns version when claudev is on PATH", async () => {
    const result = await probeClaudev();
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.version).toBeDefined();
    expect(result.version!).toMatch(/^\d+\.\d+/);
  });

  test.if(!hasClaudev)("handles missing claudev gracefully via ENOENT", async () => {
    const result = await probeClaudev("claudev-does-not-exist-xyz");
    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.error).toBeDefined();
  });

  test("handles non-existent binary gracefully regardless of PATH", async () => {
    const result = await probeClaudev("definitely-not-a-real-binary-12345");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
