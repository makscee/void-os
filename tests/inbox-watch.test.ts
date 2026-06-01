// tests/inbox-watch.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, upsertTrigger } from "../src/registry.ts";
import { drainInbox } from "../src/inbox-watch.ts";

function tmpVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vos-inbox-"));
  mkdirSync(join(v, "inbox"), { recursive: true });
  return v;
}

test("drainInbox fires the bound event trigger once per new line, passing the line as input", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  upsertTrigger(db, { name: "avito-t", kind: "event", skill: "triage", agent: "default", cronExpr: null, inbox: "avito", stepCeiling: 50, now: 0 });
  const inbox = join(vault, "inbox", "avito.jsonl");
  writeFileSync(inbox, JSON.stringify({ msg: "hello" }) + "\n");
  const fired: Array<{ name: string; input: string | null }> = [];
  const offsets = new Map<string, number>();
  const fire = (name: string, input: string | null) => { fired.push({ name, input }); };
  drainInbox(db, vault, offsets, fire);
  expect(fired.length).toBe(1);
  expect(fired[0].name).toBe("avito-t");
  expect(JSON.parse(fired[0].input!).msg).toBe("hello");
  // append a second line; only the new one fires
  appendFileSync(inbox, JSON.stringify({ msg: "second" }) + "\n");
  drainInbox(db, vault, offsets, fire);
  expect(fired.length).toBe(2);
  expect(JSON.parse(fired[1].input!).msg).toBe("second");
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
