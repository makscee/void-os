// tests/triggers-reconcile.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, listTriggers, getTrigger } from "../src/registry.ts";
import { reconcileTriggers } from "../src/triggers-reconcile.ts";

function tmpVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vos-trig-"));
  mkdirSync(join(v, "triggers"), { recursive: true });
  return v;
}

test("reconcileTriggers loads files into rows and computes next_fire_at for schedules", () => {
  const vault = tmpVault();
  writeFileSync(join(vault, "triggers", "morning.md"),
    `---\nkind: schedule\nskill: morning-report\nagent: default\ncron_expr: "0 9 * * *"\n---\n`);
  writeFileSync(join(vault, "triggers", "manual-x.md"),
    `---\nkind: manual\nskill: x\nagent: default\n---\n`);
  const db = openRegistry(":memory:");
  const now = Date.UTC(2026, 5, 1, 8, 0, 0);
  reconcileTriggers(db, vault, now);
  expect(listTriggers(db).length).toBe(2);
  const sched = getTrigger(db, "morning")!;
  expect(sched.next_fire_at).toBe(Date.UTC(2026, 5, 1, 9, 0, 0));
  const man = getTrigger(db, "manual-x")!;
  expect(man.next_fire_at).toBeNull(); // manual triggers never schedule
});

test("reconcileTriggers is idempotent and preserves last_fired_at across re-reconcile", () => {
  const vault = tmpVault();
  writeFileSync(join(vault, "triggers", "m.md"), `---\nkind: manual\nskill: x\nagent: default\n---\n`);
  const db = openRegistry(":memory:");
  reconcileTriggers(db, vault, 1000);
  // simulate a fire stamping last_fired_at
  db.query("UPDATE triggers SET last_fired_at = 5000 WHERE name = 'm'").run();
  reconcileTriggers(db, vault, 2000);
  expect(getTrigger(db, "m")!.last_fired_at).toBe(5000);
  expect(listTriggers(db).length).toBe(1);
});

test("reconcileTriggers skips a malformed trigger file without throwing", () => {
  const vault = tmpVault();
  writeFileSync(join(vault, "triggers", "bad.md"), `---\nkind: schedule\nskill: x\nagent: default\ncron_expr: "nonsense"\n---\n`);
  writeFileSync(join(vault, "triggers", "ok.md"), `---\nkind: manual\nskill: x\nagent: default\n---\n`);
  const db = openRegistry(":memory:");
  reconcileTriggers(db, vault, 0);
  expect(getTrigger(db, "ok")).not.toBeNull();
  expect(getTrigger(db, "bad")).toBeNull();
});
