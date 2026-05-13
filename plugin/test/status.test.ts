import { describe, test, expect } from "bun:test";
import { StatusBar } from "../src/status";

class FakeEl {
  text = "";
  setText(s: string) { this.text = s; }
}

describe("StatusBar", () => {
  test("initial state is offline", () => {
    const el = new FakeEl();
    new StatusBar(el as any);
    expect(el.text).toBe("void-os: offline");
  });

  test("update to connected", () => {
    const el = new FakeEl();
    const sb = new StatusBar(el as any);
    sb.update("connected");
    expect(el.text).toBe("void-os: connected");
  });

  test("update to reconnecting", () => {
    const el = new FakeEl();
    const sb = new StatusBar(el as any);
    sb.update("reconnecting");
    expect(el.text).toBe("void-os: reconnecting");
  });

  test("update to offline", () => {
    const el = new FakeEl();
    const sb = new StatusBar(el as any);
    sb.update("connected");
    sb.update("offline");
    expect(el.text).toBe("void-os: offline");
  });
});
