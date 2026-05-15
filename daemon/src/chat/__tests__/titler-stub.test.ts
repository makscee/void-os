import { describe, test, expect } from "bun:test";
import { makeTitlerStub } from "../titler-stub.ts";

describe("makeTitlerStub", () => {
  test("returns a Titler whose methods resolve no-op", async () => {
    const t = makeTitlerStub();
    const result = await t.title("c1");
    expect(result).toBeUndefined();
  });
});
