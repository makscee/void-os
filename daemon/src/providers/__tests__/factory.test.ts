import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { makeProvider } from "../factory.ts";

function tmpJsonl(): string {
  const p = path.join(os.tmpdir(), `factory-${Date.now()}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: "system", session_id: "s" }) + "\n");
  return p;
}

describe("makeProvider", () => {
  test("default ⇒ claude-code", () => {
    const p = makeProvider({}, fakeDeps());
    expect(p.name).toBe("claude-code");
  });

  test("VOS_PROVIDER=fake ⇒ fake", () => {
    const p = makeProvider(
      { VOS_PROVIDER: "fake", VOS_FAKE_SCRIPT: tmpJsonl() },
      fakeDeps(),
    );
    expect(p.name).toBe("fake");
  });

  test("VOS_PROVIDER=fake with missing VOS_FAKE_SCRIPT ⇒ throws", () => {
    expect(() => makeProvider({ VOS_PROVIDER: "fake" }, fakeDeps())).toThrow(
      /VOS_FAKE_SCRIPT/,
    );
  });

  test("unknown VOS_PROVIDER ⇒ throws", () => {
    expect(() => makeProvider({ VOS_PROVIDER: "weird" }, fakeDeps())).toThrow(
      /unknown provider/,
    );
  });
});

function fakeDeps() {
  // ProviderDeps grew engine/daemonBase/hookScriptPath/loadAgentDefn since this
  // fixture was written; makeProvider does not exercise them here (VOS-167).
  return {
    bus: { emit: () => {}, subscribe: () => () => {}, query: async () => [] } as any,
    db: {} as any,
    tracesDir: "/tmp/traces",
    agent: "maya",
    cwd: "/tmp",
    engine: {} as any,
    daemonBase: "http://localhost:0",
    hookScriptPath: "/tmp/hook.ts",
    loadAgentDefn: (() => ({})) as any,
  };
}
