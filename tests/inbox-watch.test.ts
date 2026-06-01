// tests/inbox-watch.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, upsertTrigger } from "../src/registry.ts";
import { drainInbox } from "../src/inbox-watch.ts";
import { busLinePath } from "../src/paths.ts";

function tmpVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vos-inbox-"));
  mkdirSync(join(v, "inbox"), { recursive: true });
  return v;
}

// Back-compat: kindless trigger fires for any bus-format line on its inbox.
test("drainInbox fires the bound event trigger once per new line (bus-format, kindless trigger)", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "avito-t", kind: "event", skill: "triage", agent: "default", cronExpr: null, inbox: "avito", eventKind: null, stepCeiling: 50, now: 0 });
  const inbox = join(vault, "inbox", "avito.jsonl");
  const id1 = "bl-hello-1";
  writeFileSync(inbox, JSON.stringify({ channel: "file", kind: "idea", payload: "hello", id: id1, ts: 1 }) + "\n");
  const fired: Array<{ name: string; input: string | null; inputRef: string | null }> = [];
  const offsets = new Map<string, number>();
  const fire = (name: string, input: string | null, inputRef: string | null) => { fired.push({ name, input, inputRef }); };
  drainInbox(db, vault, offsets, fire);
  expect(fired.length).toBe(1);
  expect(fired[0].name).toBe("avito-t");
  expect(fired[0].input).toBe("hello"); // payload text, not raw JSON
  expect(fired[0].inputRef).toBe(busLinePath(vault, id1));
  // append a second line; only the new one fires
  const id2 = "bl-hello-2";
  appendFileSync(inbox, JSON.stringify({ channel: "file", kind: "idea", payload: "second", id: id2, ts: 2 }) + "\n");
  drainInbox(db, vault, offsets, fire);
  expect(fired.length).toBe(2);
  expect(fired[1].input).toBe("second");
});

test("drainInbox ignores blank lines and inboxes with no event trigger", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  // no trigger bound to "orphan"
  writeFileSync(join(vault, "inbox", "orphan.jsonl"), "\n\n");
  const fired: string[] = [];
  drainInbox(db, vault, new Map(), (n) => fired.push(n));
  expect(fired).toEqual([]);
});

test("drainInbox parses a bus line, writes input-ref file, routes by kind, fires resolved trigger", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "idea-t", kind: "event", skill: "intake", agent: "default", cronExpr: null, inbox: "bus", eventKind: "idea", stepCeiling: 50, now: 0 });
  upsertTrigger(db, { name: "chat-t", kind: "event", skill: "chat", agent: "default", cronExpr: null, inbox: "bus", eventKind: "chat", stepCeiling: 50, now: 0 });
  const id = "bl-test-1";
  appendFileSync(join(vault, "inbox", "bus.jsonl"),
    JSON.stringify({ channel: "file", kind: "idea", payload: "make a task", id, ts: 1 }) + "\n");
  const fired: Array<{ name: string; input: string | null; inputRef: string | null }> = [];
  drainInbox(db, vault, new Map(), (name, input, inputRef) => fired.push({ name, input, inputRef }));
  expect(fired).toHaveLength(1);
  expect(fired[0].name).toBe("idea-t");
  expect(fired[0].inputRef).toBe(busLinePath(vault, id));
  expect(fired[0].input).toBe("make a task"); // payload, not raw JSON
  // the input-ref file exists and round-trips the parsed line
  expect(JSON.parse(readFileSync(busLinePath(vault, id), "utf8")).kind).toBe("idea");
});

test("drainInbox skips an unroutable line without throwing", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  // only an idea-t trigger registered — no match for decision-reply
  upsertTrigger(db, { name: "idea-t", kind: "event", skill: "intake", agent: "default", cronExpr: null, inbox: "bus", eventKind: "idea", stepCeiling: 50, now: 0 });
  appendFileSync(join(vault, "inbox", "bus.jsonl"),
    JSON.stringify({ channel: "file", kind: "decision-reply", payload: "x", id: "bl-x", ts: 1 }) + "\n");
  const fired: unknown[] = [];
  expect(() => drainInbox(db, vault, new Map(), (...a) => fired.push(a))).not.toThrow();
  expect(fired).toHaveLength(0);
});

test("drainInbox skips a malformed (non-JSON) line without throwing", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "t", kind: "event", skill: "s", agent: "a", cronExpr: null, inbox: "bus", eventKind: null, stepCeiling: 50, now: 0 });
  appendFileSync(join(vault, "inbox", "bus.jsonl"), "this is not json\n");
  const fired: unknown[] = [];
  expect(() => drainInbox(db, vault, new Map(), (...a) => fired.push(a))).not.toThrow();
  expect(fired).toHaveLength(0);
});
