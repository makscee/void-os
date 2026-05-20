import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPermissionEngine } from "../engine";

const HOOK = join(import.meta.dir, "..", "..", "providers", "claude-code", "hook-bin", "pre-tool-use.ts");
const VAULT = "/tmp/vos-106-fuzz-vault";

async function hookDecide(toolPath: string, readPaths: string[]): Promise<boolean> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      VOS_READ_PATHS: JSON.stringify(readPaths),
      VOS_WRITE_PATHS: JSON.stringify(readPaths),
      VOS_SYSTEM_DENY: JSON.stringify([]),
      VOS_VAULT_ROOT: VAULT,
    },
  });
  proc.stdin.write(JSON.stringify({ tool_name: "Read", tool_input: { file_path: toolPath } }));
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  // Hook now uses {continue: true, decision: "block"} to deny tool calls so the
  // session survives (continue:false would terminate CC outright). Treat any
  // "block" decision as a deny for engine/hook parity.
  const out_d = JSON.parse(out.trim()) as { continue: boolean; decision?: "block" };
  return out_d.continue && out_d.decision !== "block";
}

// Pseudo-random but deterministic (seeded). Avoids flaky reruns.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

describe("matchPath parity: engine vs hook", () => {
  it("agrees on 100 random (path, scope) pairs", async () => {
    const engine = createPermissionEngine({ vaultRoot: VAULT, homeRoot: "/tmp/home" });
    const segments = ["journal", "work", "agents", "notes", "tasks", "active", "backlog"];
    const exts = [".md", ".txt", ".json"];
    const rand = rng(12345);

    let mismatches = 0;
    for (let i = 0; i < 100; i++) {
      const depth = 1 + Math.floor(rand() * 4);
      const parts = Array.from({ length: depth }, () => pick(rand, segments));
      const ext = pick(rand, exts);
      const absPath = `${VAULT}/${parts.join("/")}${ext}`;

      const scopeRoot = pick(rand, segments);
      const scope = [`${VAULT}/${scopeRoot}/**`];

      const agent = { name: "fuzz", read_scope: scope, write_scope: scope };
      const engineAllow = engine.canRead(absPath, agent);
      const hookAllow = await hookDecide(absPath, scope);

      if (engineAllow !== hookAllow) {
        mismatches++;
        console.error(`MISMATCH #${i}: path=${absPath} scope=${scope[0]} engine=${engineAllow} hook=${hookAllow}`);
      }
    }
    expect(mismatches).toBe(0);
  });
});
