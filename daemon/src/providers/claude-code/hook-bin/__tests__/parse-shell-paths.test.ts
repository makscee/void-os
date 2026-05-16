import { describe, expect, it } from "bun:test";
import { parseShellPaths } from "../parse-shell-paths";

describe("parseShellPaths", () => {
  it("no-path verb: pwd → empty reads/writes", () => {
    expect(parseShellPaths("pwd")).toEqual({ reads: [], writes: [] });
  });
  it("no-path verb: git status → empty", () => {
    expect(parseShellPaths("git status")).toEqual({ reads: [], writes: [] });
  });
  it("read-like: cat vault/x.md → reads", () => {
    expect(parseShellPaths("cat vault/journal/X.md")).toEqual({
      reads: ["vault/journal/X.md"],
      writes: [],
    });
  });
  it("read-like with flags: ls -la vault/work", () => {
    expect(parseShellPaths("ls -la vault/work")).toEqual({
      reads: ["vault/work"],
      writes: [],
    });
  });
  it("write-like: mv a.md b.md → writes both", () => {
    expect(parseShellPaths("mv vault/a.md vault/b.md")).toEqual({
      reads: [],
      writes: ["vault/a.md", "vault/b.md"],
    });
  });
  it("redirect: echo hi > vault/note.md → writes target", () => {
    expect(parseShellPaths("echo hi > vault/note.md")).toEqual({
      reads: [],
      writes: ["vault/note.md"],
    });
  });
  it("redirect append: echo hi >> vault/log.md", () => {
    expect(parseShellPaths("echo hi >> vault/log.md")).toEqual({
      reads: [],
      writes: ["vault/log.md"],
    });
  });
  it("unknown verb with path: deny via conservative read gate", () => {
    expect(parseShellPaths("foobar vault/secret.md")).toEqual({
      reads: ["vault/secret.md"],
      writes: [],
    });
  });
  it("unknown verb without paths: allow (empty)", () => {
    expect(parseShellPaths("foobar --flag")).toEqual({ reads: [], writes: [] });
  });
  it("shell substitution → SHELL_SUBSTITUTION sentinel (matchPath can't allow)", () => {
    expect(parseShellPaths("cat $(ls vault/)")).toEqual({
      reads: ["__SHELL_SUBSTITUTION__"],
      writes: [],
    });
  });
  it("backtick substitution → sentinel", () => {
    expect(parseShellPaths("echo `ls vault/`")).toEqual({
      reads: ["__SHELL_SUBSTITUTION__"],
      writes: [],
    });
  });
  it("dollar-brace expansion → sentinel", () => {
    expect(parseShellPaths('cat ${HOME}/secret')).toEqual({
      reads: ["__SHELL_SUBSTITUTION__"],
      writes: [],
    });
  });
  it("git show file → reads file token", () => {
    expect(parseShellPaths("git show HEAD:vault/x.md")).toEqual({
      reads: ["HEAD:vault/x.md"],
      writes: [],
    });
  });
});
