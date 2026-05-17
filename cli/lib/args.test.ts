import { test, expect } from "bun:test";
import { parseArgs } from "./args.ts";

test("collects positionals and flags", () => {
  const r = parseArgs(["read", "notes.md", "--json"], { flags: ["json"], values: [] });
  expect(r.positional).toEqual(["read", "notes.md"]);
  expect(r.flags.json).toBe(true);
});

test("--key value form", () => {
  const r = parseArgs(["--port", "8080"], { flags: [], values: ["port"] });
  expect(r.values.port).toBe("8080");
});

test("--key=value form", () => {
  const r = parseArgs(["--port=8080"], { flags: [], values: ["port"] });
  expect(r.values.port).toBe("8080");
});

test("short bool flag -f", () => {
  const r = parseArgs(["-f"], { flags: ["follow"], values: [], shortMap: { f: "follow" } });
  expect(r.flags.follow).toBe(true);
});

test("--help is always parsed", () => {
  const r = parseArgs(["--help"], { flags: [], values: [] });
  expect(r.help).toBe(true);
});

test("missing value for --key throws", () => {
  expect(() => parseArgs(["--port"], { flags: [], values: ["port"] })).toThrow(/--port expects a value/);
});

test("unknown flag throws", () => {
  expect(() => parseArgs(["--weird"], { flags: [], values: [] })).toThrow(/unknown flag.*--weird/);
});

test("-- ends flag parsing", () => {
  const r = parseArgs(["--json", "--", "--not-a-flag"], { flags: ["json"], values: [] });
  expect(r.flags.json).toBe(true);
  expect(r.positional).toEqual(["--not-a-flag"]);
});
