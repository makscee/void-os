// tui.test.ts — pure-logic tests for the TUI menu module
import { describe, it, expect } from "bun:test";
import { MENU_ITEMS, actionToArgv, type MenuAction } from "../src/tui.ts";

describe("MENU_ITEMS", () => {
  it("contains all required actions", () => {
    const values = MENU_ITEMS.map((i) => i.value);
    expect(values).toContain("init");
    expect(values).toContain("serve");
    expect(values).toContain("list-sessions");
    expect(values).toContain("quit");
  });

  it("every item has a non-empty label", () => {
    for (const item of MENU_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("every item has a non-empty hint", () => {
    for (const item of MENU_ITEMS) {
      expect(item.hint).toBeDefined();
      expect((item.hint ?? "").length).toBeGreaterThan(0);
    }
  });

  it("values are unique", () => {
    const values = MENU_ITEMS.map((i) => i.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe("actionToArgv", () => {
  it("maps init → ['init']", () => {
    expect(actionToArgv("init")).toEqual(["init"]);
  });

  it("maps serve → ['serve']", () => {
    expect(actionToArgv("serve")).toEqual(["serve"]);
  });

  it("maps list-sessions → ['list-sessions']", () => {
    expect(actionToArgv("list-sessions")).toEqual(["list-sessions"]);
  });

  it("maps quit → [] (empty, exit cleanly)", () => {
    expect(actionToArgv("quit")).toEqual([]);
  });

  it("every non-quit action maps to a non-empty argv", () => {
    const actions: MenuAction[] = ["init", "serve", "list-sessions"];
    for (const action of actions) {
      expect(actionToArgv(action).length).toBeGreaterThan(0);
    }
  });

  it("every MENU_ITEMS value has a defined mapping (no missing cases)", () => {
    for (const item of MENU_ITEMS) {
      // actionToArgv should not throw
      const argv = actionToArgv(item.value);
      expect(Array.isArray(argv)).toBe(true);
    }
  });
});
