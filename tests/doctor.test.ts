import { expect, test } from "bun:test";
import { renderDoctorTable, killStaleDaemons, type DaemonInfo } from "../src/doctor.ts";

const mk = (vault: string, port: number, pid: number): DaemonInfo => ({ vault, port, pid });

test("renderDoctorTable shows pid, port, vault and a stale flag per daemon", () => {
  const target = "/abs/target";
  const daemons = [mk("/abs/target", 4317, 100), mk("/abs/other", 60013, 200)];
  const txt = renderDoctorTable(daemons, target);
  expect(txt).toContain("100");
  expect(txt).toContain("4317");
  expect(txt).toContain("/abs/target");
  expect(txt).toContain("60013");
  expect(txt).toContain("/abs/other");
  // the foreign-vault daemon is marked stale, the target-vault one is not
  const otherLine = txt.split("\n").find((l) => l.includes("/abs/other"))!;
  const targetLine = txt.split("\n").find((l) => l.includes("4317"))!;
  expect(otherLine.toLowerCase()).toContain("stale");
  expect(targetLine.toLowerCase()).not.toContain("stale");
});

test("renderDoctorTable handles zero daemons", () => {
  expect(renderDoctorTable([], "/abs/target")).toMatch(/no .*void-os daemons/i);
});

test("killStaleDaemons kills every stale daemon, skips same-vault, skips self", async () => {
  const target = "/abs/target";
  const daemons = [
    mk("/abs/target", 4317, 100),  // same vault — keep
    mk("/abs/other", 60013, 200),  // stale — kill
    mk("/abs/third", 51634, 300),  // stale — kill
    mk("/abs/fourth", 3001, 999),  // stale BUT pid==self — never kill
  ];
  const killed: number[] = [];
  await killStaleDaemons(daemons, target, {
    selfPid: 999,
    kill: async (pid) => { killed.push(pid); },
  });
  expect(killed.sort()).toEqual([200, 300]);
});
