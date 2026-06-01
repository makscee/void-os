import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutputTarget, wasMutatedSince } from "../src/output-target.ts";

function tmpVault() { return mkdtempSync(join(tmpdir(), "vos-ot-")); }

test("resolveOutputTarget joins a literal target onto the vault", () => {
  const v = tmpVault();
  expect(resolveOutputTarget(v, "reports/out.html")).toBe(join(v, "reports/out.html"));
});

test("wasMutatedSince is false when the target does not exist", () => {
  const v = tmpVault();
  expect(wasMutatedSince(v, "reports/out.html", 1000)).toBe(false);
});

test("wasMutatedSince is true when the file mtime >= start", () => {
  const v = tmpVault();
  mkdirSync(join(v, "reports"), { recursive: true });
  const f = join(v, "reports/out.html");
  writeFileSync(f, "x");
  utimesSync(f, new Date(5000), new Date(5000)); // mtime = 5000ms epoch
  expect(wasMutatedSince(v, "reports/out.html", 4000)).toBe(true);
  expect(wasMutatedSince(v, "reports/out.html", 6000)).toBe(false);
});

test("wasMutatedSince supports a single-star glob (any match mutated since start)", () => {
  const v = tmpVault();
  mkdirSync(join(v, "reports"), { recursive: true });
  const f = join(v, "reports/a.html");
  writeFileSync(f, "x");
  utimesSync(f, new Date(5000), new Date(5000));
  expect(wasMutatedSince(v, "reports/*.html", 4000)).toBe(true);
  expect(wasMutatedSince(v, "reports/*.html", 6000)).toBe(false);
});

test("empty target never counts as mutated", () => {
  const v = tmpVault();
  expect(wasMutatedSince(v, "", 0)).toBe(false);
});
