import { test, expect } from "bun:test";
import { isExcluded } from "../src/vault/exclude.ts";

test("plain file not excluded", () => {
  expect(isExcluded("notes/foo.md")).toBe(false);
});

test(".obsidian/* excluded", () => {
  expect(isExcluded(".obsidian/workspace.json")).toBe(true);
});

test(".git/* excluded", () => {
  expect(isExcluded(".git/HEAD")).toBe(true);
});

test("nested dotfile excluded", () => {
  expect(isExcluded("notes/.private.md")).toBe(true);
});

test("hidden dir at deep level excluded", () => {
  expect(isExcluded("notes/sub/.cache/foo")).toBe(true);
});

test("file named with leading dot excluded", () => {
  expect(isExcluded(".env")).toBe(true);
});

test("path with dots not at segment start is fine", () => {
  expect(isExcluded("notes/foo.bar.md")).toBe(false);
});
