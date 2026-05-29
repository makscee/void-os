import { expect, test } from "bun:test";
import { checkPrereqs } from "../src/preflight.ts";

test("all good when vc + claude on PATH and vc status logged in", async () => {
  const r = await checkPrereqs({
    which: async (b) => b === "vc" || b === "claude",
    vcStatus: async () => ({ ok: true, text: "logged in" }),
  });
  expect(r.ok).toBe(true);
  expect(r.problems).toHaveLength(0);
  expect(r.needsLogin).toBe(false);
});

test("fails with remediation when vc missing", async () => {
  const r = await checkPrereqs({
    which: async (b) => b !== "vc",
    vcStatus: async () => ({ ok: false, text: "" }),
  });
  expect(r.ok).toBe(false);
  expect(r.problems.join(" ")).toContain("vc not found");
});

test("fails when claude missing", async () => {
  const r = await checkPrereqs({
    which: async (b) => b === "vc",
    vcStatus: async () => ({ ok: true, text: "logged in" }),
  });
  expect(r.ok).toBe(false);
  expect(r.problems.join(" ")).toContain("claude not found");
});

test("flags logged-out vc (fatal for headless spawn)", async () => {
  const r = await checkPrereqs({
    which: async () => true,
    vcStatus: async () => ({ ok: false, text: "no token" }),
  });
  expect(r.ok).toBe(false);
  expect(r.needsLogin).toBe(true);
});

test("collects multiple problems", async () => {
  const r = await checkPrereqs({
    which: async () => false,
    vcStatus: async () => ({ ok: false, text: "" }),
  });
  expect(r.ok).toBe(false);
  expect(r.problems.length).toBeGreaterThan(1);
});
