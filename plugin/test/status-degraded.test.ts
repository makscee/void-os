import { describe, test, expect } from "bun:test";
import { StatusBar } from "../src/status";

function makeEl() {
  let text = "";
  return {
    setText(s: string) { text = s; },
    get text() { return text; },
  };
}

describe("StatusBar mode gate", () => {
  test("defaults to fsm mode — update() writes labels", () => {
    const el = makeEl();
    const sb = new StatusBar(el);
    sb.update("connected");
    expect(el.text).toBe("void-os: connected");
  });

  test("setMode('degraded') makes update() a no-op until setMode('fsm')", () => {
    const el = makeEl();
    const sb = new StatusBar(el);
    sb.setMode("degraded");
    sb.setStateText("void-os: binary-missing");
    expect(el.text).toBe("void-os: binary-missing");
    sb.update("connected"); // FSM tick — must be ignored
    expect(el.text).toBe("void-os: binary-missing");
    sb.setMode("fsm");
    sb.update("connected");
    expect(el.text).toBe("void-os: connected");
  });

  test("setStateText writes unconditionally", () => {
    const el = makeEl();
    const sb = new StatusBar(el);
    sb.setStateText("anything");
    expect(el.text).toBe("anything");
  });
});
