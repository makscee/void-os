import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureToken } from "../src/auth/token.ts";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vos-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("ensureToken generates a new token when file absent", () => {
  const token = ensureToken();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const tokenFile = path.join(tmpHome, ".void-os", "token");
  expect(fs.existsSync(tokenFile)).toBe(true);
  expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(token);
});

test("ensureToken reuses existing token", () => {
  fs.mkdirSync(path.join(tmpHome, ".void-os"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tmpHome, ".void-os", "token"), "deadbeef".repeat(8) + "\n", { mode: 0o600 });
  const token = ensureToken();
  expect(token).toBe("deadbeef".repeat(8));
});

test("ensureToken sets file mode 0600 on creation", () => {
  ensureToken();
  const stat = fs.statSync(path.join(tmpHome, ".void-os", "token"));
  // On macOS/Linux: only owner read+write.
  expect(stat.mode & 0o777).toBe(0o600);
});
