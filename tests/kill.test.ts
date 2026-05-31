import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { killProcessTree } from "../src/kill.ts";

function groupCount(pid: number): number {
  const out = spawnSync("bash", ["-c", `pgrep -g ${pid} | wc -l`]).stdout.toString().trim();
  return parseInt(out, 10);
}

test("killProcessTree kills the whole process group (parent + grandchildren)", async () => {
  // bash that forks two children that outlive a parent-only kill
  const proc = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" });
  const pid = proc.pid!;
  await new Promise((r) => setTimeout(r, 200));
  expect(groupCount(pid)).toBeGreaterThanOrEqual(2);
  await killProcessTree(pid);
  await new Promise((r) => setTimeout(r, 200));
  expect(groupCount(pid)).toBe(0);
}, 10000);

test("killProcessTree escalates to SIGKILL for a SIGTERM-ignoring process", async () => {
  // trap '' TERM => ignores SIGTERM; only SIGKILL ends it
  const proc = spawn("bash", ["-c", "trap '' TERM; sleep 30"], { detached: true, stdio: "ignore" });
  const pid = proc.pid!;
  await new Promise((r) => setTimeout(r, 200));
  await killProcessTree(pid, { graceMs: 300 });
  await new Promise((r) => setTimeout(r, 400));
  expect(groupCount(pid)).toBe(0); // SIGKILL got it after the grace window
}, 10000);

test("killProcessTree is a no-op for an already-dead pid", async () => {
  const proc = spawn("true", [], { detached: true, stdio: "ignore" });
  const pid = proc.pid!;
  await new Promise((r) => setTimeout(r, 200)); // let it exit naturally
  // Should not throw even though the group is gone
  await expect(killProcessTree(pid)).resolves.toBeUndefined();
});
