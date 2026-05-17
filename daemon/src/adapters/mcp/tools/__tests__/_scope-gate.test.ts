import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPermissionEngine } from "../../../../permissions/engine";
import { assertCanWrite, assertCanRead, errResult } from "../_scope-gate";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-gate-")));
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  return { root, engine };
}

describe("_scope-gate", () => {
  it("assertCanWrite returns null when permitted", () => {
    const { root, engine } = setup();
    const res = assertCanWrite(engine, { name: "a", write_scope: ["vault/**"] }, "foo.md", join(root, "foo.md"));
    expect(res).toBeNull();
  });

  it("assertCanWrite returns SCOPE_DENIED envelope when denied", () => {
    const { root, engine } = setup();
    const res = assertCanWrite(engine, { name: "maya", write_scope: [] }, "foo.md", join(root, "foo.md"));
    expect(res).not.toBeNull();
    expect(res!.isError).toBe(true);
    const text = (res!.content[0] as { text: string }).text;
    expect(text).toBe("SCOPE_DENIED: foo.md outside write_scope for agent maya");
  });

  it("assertCanRead returns SCOPE_DENIED for read with same shape", () => {
    const { root, engine } = setup();
    const res = assertCanRead(engine, { name: "a", read_scope: ["vault/journal/**"] }, "work/x.md", join(root, "work/x.md"));
    expect(res).not.toBeNull();
    const text = (res!.content[0] as { text: string }).text;
    expect(text).toBe("SCOPE_DENIED: work/x.md outside read_scope for agent a");
  });

  it("errResult shape matches vault.read", () => {
    const r = errResult("FOO", "bar");
    expect(r).toEqual({ isError: true, content: [{ type: "text", text: "FOO: bar" }] });
  });
});
