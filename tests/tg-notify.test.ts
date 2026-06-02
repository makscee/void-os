import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyDecision } from "../src/tg-notify.ts";
import { tgOutboxPath } from "../src/paths.ts";
import { appendDecision } from "../src/decision.ts";

function tmpVault(): string { return mkdtempSync(join(tmpdir(), "vos-tg-")); }

test("notifyDecision appends a notification line to the TG outbox file", () => {
  const v = tmpVault();
  const d = appendDecision(v, { question: "Push?", options: ["y", "n"], originExecId: "ex-1", context: "c", now: 1 });
  notifyDecision(v, d);
  expect(existsSync(tgOutboxPath(v))).toBe(true);
  const line = JSON.parse(readFileSync(tgOutboxPath(v), "utf8").trim());
  expect(line.decisionId).toBe(d.id);
  expect(line.text).toContain("Push?");
  expect(line.channel).toBe("tg-stub");
});
