// attach.test.ts — unit tests for the void-os attach CLI helpers.
// VOS-205 T6: pure-function tests only; runAttach() blocks the terminal so NOT tested here.
import { test, expect } from "bun:test";
import { followTargetName, attachInvocation } from "../src/attach.ts";

test("followTargetName is the stable daemon-retargetable session", () => {
  expect(followTargetName()).toBe("vos-follow");
});

test("attachInvocation targets the -L vos socket and the follow session", () => {
  expect(attachInvocation()).toBe("tmux -L vos attach -t vos-follow");
});
